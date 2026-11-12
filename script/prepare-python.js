"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const VERSION = "3.15.2";
const RELEASE = "3.15.2-40340363276";
const API = "https://api.github.com/repos/actions/python-versions/releases";
const DOWNLOAD = `https://github.com/actions/python-versions/releases/download/${RELEASE}`;
// The original setup-python distribution, verified against this release's
// hashes.sha256 and GitHub asset digests. No mirror or rebuilt Python is used.
const CHECKSUMS = {
  "darwin-arm64": "43e924c37f9987e722439ad4cf63b1d90617a96b1655f0999118a33eb7cc2b3e",
  "darwin-x64": "3598759050401152244152503382874410ef8071fb1156544a3bd233ddcf148f",
  "linux-22.04-arm64": "cb1ae537f8e9a1d75746efe83612c7280b3c64d7471f1a10028497cd62b329b2",
  "linux-22.04-x64": "fb97a9a2211b848c4e17481a06948b9bad5bd64eb50707f04f9b682715c2fce4",
  "linux-24.04-arm64": "ca452e51c1efb21148c09f5766757fd6793555903492b6e363b02786cbdcf9ab",
  "linux-24.04-x64": "a945ca657bf4efeac7483c0c82381448d3b651a8d0e49be421c71fd53085cd01",
  "linux-26.04-arm64": "1bd2f706ee858baf0c48c5ecc9b3e47400e3bd366c61270f38e411ed7c346411",
  "linux-26.04-x64": "2c5bc8461e5c9537914c7b6b2fb212c733f2a6f3e20045763538e5d9ac99f43e",
  "win32-arm64": "6af13bbb6984d392c8a2d8a37f43b724d28ad530b49743f5de42e13ca76c2726",
  "win32-x64": "f907cc89f1cdadd15488190b487da6aa59cffe1df23de9670fe014a75204592c",
  "win32-x86": "5423be781f9e7a0d1775d0d748800e3eb5332c9850e3bd5c7425bd668d73c8c7",
};

function selectAsset(platform, arch, osRelease = "") {
  arch = arch === "ia32" ? "x86" : arch;
  let target = `${platform}-${arch}`;
  if (platform === "linux") {
    const fields = Object.fromEntries(
      osRelease.split(/\r?\n/).map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, "")];
      }),
    );
    if (fields.ID !== "ubuntu") throw new Error("The Python CI bootstrap requires Ubuntu");
    target = `linux-${fields.VERSION_ID}-${arch}`;
  }
  const sha256 = CHECKSUMS[target];
  if (!sha256) throw new Error(`No verified Python ${VERSION} distribution for ${target}`);
  const filename = `python-${VERSION}-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
  return { filename, sha256, url: `${DOWNLOAD}/${filename}` };
}

function apiHeaders(accept, token) {
  if (
    token &&
    (typeof token !== "string" ||
      [...token].some((character) => {
        const code = character.charCodeAt(0);
        return code < 33 || code > 126;
      }))
  )
    throw new Error("Invalid GitHub API token");
  return { Accept: accept, ...(token && { Authorization: `Bearer ${token}` }) };
}

async function downloadArchive(
  asset,
  destination,
  { fetch = globalThis.fetch, signal, token } = {},
) {
  signal ??= AbortSignal.timeout(120000);
  let response;
  // Authenticated CI can resolve the same pinned official asset directly.
  // A stalled browser-download frontend must not consume the whole deadline
  // before the API route can start. Public tokenless downloads retain it.
  if (!token) {
    try {
      response = await fetch(asset.url, { signal });
    } catch (error) {
      if (signal.aborted || !(error instanceof TypeError && error.message === "fetch failed"))
        throw error;
    }
  }
  if (!response || [408, 429].includes(response.status) || response.status >= 500) {
    signal.throwIfAborted();
    await response?.body?.cancel();
    const metadata = await fetch(`${API}/tags/${RELEASE}`, {
      headers: apiHeaders("application/vnd.github+json", token),
      redirect: "error",
      signal,
    });
    if (!metadata.ok) throw new Error(`Official Python metadata returned HTTP ${metadata.status}`);
    const release = await metadata.json();
    const matches = release.assets?.filter(
      (entry) => entry.name === asset.filename && entry.browser_download_url === asset.url,
    );
    const selected = matches?.[0];
    if (
      release.tag_name !== RELEASE ||
      matches?.length !== 1 ||
      !Number.isSafeInteger(selected.id) ||
      selected.id <= 0 ||
      selected.digest !== `sha256:${asset.sha256}`
    )
      throw new Error("The official Python release does not match the pinned archive");
    signal.throwIfAborted();
    response = await fetch(`${API}/assets/${selected.id}`, {
      headers: apiHeaders("application/octet-stream", token),
      redirect: "manual",
      signal,
    });
    if (response.status === 302) {
      let location;
      try {
        location = new URL(response.headers.get("location"));
      } catch {
        throw new Error("The official Python asset redirect has no valid location");
      }
      if (
        location.protocol !== "https:" ||
        location.port ||
        location.username ||
        location.password ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
          location.hostname,
        )
      )
        throw new Error("The official Python asset redirected outside the allowed asset hosts");
      signal.throwIfAborted();
      await response.body?.cancel();
      // The signed public asset request must not receive the API credential.
      response = await fetch(location.href, { signal, redirect: "error" });
    }
  }
  if (!response.ok) throw new Error(`Official Python download returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Official Python download has no body");
  const checksum = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, encoding, next) {
        checksum.update(chunk);
        next(null, chunk);
      },
    }),
    fs.createWriteStream(destination, { flags: "wx" }),
  );
  if (checksum.digest("hex") !== asset.sha256)
    throw new Error("Official Python archive checksum mismatch");
}

function execute(command, args, { capture = false, ...options }) {
  const result = spawnSync(command, args, {
    ...options,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal)
    throw new Error(`${command} failed (${result.signal || result.status})`);
  return result.stdout;
}

function cacheReady(target, platform, env, run) {
  const binary = path.join(target, platform === "win32" ? "python.exe" : "bin/python");
  if (!fs.existsSync(`${target}.complete`) || !fs.existsSync(binary)) return false;
  try {
    const version = run(
      binary,
      ["-c", 'import sys; print(".".join(map(str, sys.version_info[:3])))'],
      {
        env: {
          ...env,
          ...(platform === "linux" && {
            LD_LIBRARY_PATH:
              path.join(target, "lib") + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ""),
          }),
        },
        capture: true,
      },
    );
    return version.trim() === VERSION;
  } catch {
    return false;
  }
}

function removeOwnedStaging(owned, tempRoot) {
  if (fs.lstatSync(owned).isSymbolicLink())
    throw new Error("Unsafe Python bootstrap staging cleanup");
  const realOwned = fs.realpathSync(owned);
  if (
    realOwned !== owned ||
    path.dirname(realOwned) !== tempRoot ||
    !path.basename(realOwned).startsWith(`jupyter-python-${VERSION}-`)
  )
    throw new Error("Unsafe Python bootstrap staging cleanup");
  fs.rmSync(realOwned, { recursive: true, force: true });
}

async function preparePython({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  run = execute,
  download = downloadArchive,
  fetch = globalThis.fetch,
  signal,
  osRelease,
} = {}) {
  if (env.GITHUB_ACTIONS !== "true")
    throw new Error("The original Python bootstrap may only run on a GitHub Actions runner");
  // setup-python's HTTP client honors explicit proxy settings. Leave those
  // installations to it rather than silently taking a direct fetch route.
  if (env.HTTPS_PROXY || env.https_proxy) return { deferred: true, reason: "https-proxy" };
  const toolCache = env.AGENT_TOOLSDIRECTORY || env.RUNNER_TOOL_CACHE;
  if (
    !toolCache ||
    !path.isAbsolute(toolCache) ||
    !env.RUNNER_TEMP ||
    !path.isAbsolute(env.RUNNER_TEMP)
  )
    throw new Error("Absolute runner tool-cache and temporary directories are required");
  const architecture = arch === "ia32" ? "x86" : arch;
  const target = path.join(toolCache, "Python", VERSION, architecture);
  if (cacheReady(target, platform, env, run)) return { cached: true, target };
  const asset = selectAsset(
    platform,
    arch,
    platform === "linux" ? (osRelease ?? fs.readFileSync("/etc/os-release", "utf8")) : "",
  );
  const tempRoot = fs.realpathSync(env.RUNNER_TEMP);
  const owned = fs.mkdtempSync(path.join(tempRoot, `jupyter-python-${VERSION}-`));
  try {
    const archive = path.join(owned, asset.filename);
    const payload = path.join(owned, "payload");
    fs.mkdirSync(payload);
    await download(asset, archive, { fetch, signal, token: env.GITHUB_TOKEN });
    signal?.throwIfAborted();
    if (platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:LUMINE_PYTHON_ARCHIVE -DestinationPath $env:LUMINE_PYTHON_PAYLOAD",
        ],
        {
          env: { ...env, LUMINE_PYTHON_ARCHIVE: archive, LUMINE_PYTHON_PAYLOAD: payload },
        },
      );
    } else {
      run("tar", ["-xzf", archive, "-C", payload], { env });
    }
    // Match the original setup-python install boundary. The official scripts
    // own relocation, pip bootstrap, Windows registry work and .complete markers.
    signal?.throwIfAborted();
    run(
      platform === "win32" ? "powershell" : "bash",
      [platform === "win32" ? "./setup.ps1" : "./setup.sh"],
      {
        cwd: payload,
        env: {
          ...env,
          ...(platform === "linux" && { LD_LIBRARY_PATH: path.join(payload, "lib") }),
        },
      },
    );
    if (!cacheReady(target, platform, env, run))
      throw new Error("The original installer did not produce a complete Python 3.15.2 cache");
    return { cached: false, target, asset: asset.filename };
  } finally {
    removeOwnedStaging(owned, tempRoot);
  }
}

module.exports = {
  VERSION,
  RELEASE,
  CHECKSUMS,
  selectAsset,
  downloadArchive,
  cacheReady,
  removeOwnedStaging,
  preparePython,
};
if (require.main === module) {
  preparePython().then(
    ({ cached, deferred }) =>
      console.log(
        deferred
          ? `Python ${VERSION} transport left to setup-python because an explicit HTTPS proxy is configured`
          : `Python ${VERSION} official tool cache ${cached ? "already ready" : "prepared"}`,
      ),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
