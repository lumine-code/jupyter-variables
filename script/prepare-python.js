"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const VERSION = "3.15.1";
const RELEASE = "3.15.1-39619321210";
const API = "https://api.github.com/repos/actions/python-versions/releases";
const DOWNLOAD = `https://github.com/actions/python-versions/releases/download/${RELEASE}`;
// The original setup-python distribution, verified against this release's
// hashes.sha256 and GitHub asset digests. No mirror or rebuilt Python is used.
const CHECKSUMS = {
  "darwin-arm64": "e1a49acab28b4a180ee9819663f9e01d0e56ed49f78b1e370dedea8863301a3a",
  "darwin-x64": "cf2d9c042c9ec5a42e4ae45259faf9dfbbbd21e915ab6b892acaef5312872156",
  "linux-22.04-arm64": "f4ba4a82780f5d4035de9e86a05f08a8b46a0d4ccbe06a5bb349700ed97e88f7",
  "linux-22.04-x64": "d5089a4a7ab6cea9664fb26cdae5c6379f880edc368a5be81999455c25cda556",
  "linux-24.04-arm64": "329908df038ce3d6ab823f84c11a5f6192b660ec93edc33c0ecc33cb832d6310",
  "linux-24.04-x64": "9809d583ffee9af685f33c8746da541d7102c30a7baa7aacf0a30a1f04731a56",
  "linux-26.04-arm64": "119ef812a16900b5f4750d2b003766951f09d49b312123be25583db542c63b6e",
  "linux-26.04-x64": "0aa6f845c6f40c4a88a99e92a46374889ab9170fde378f1168e2e936b34d1218",
  "win32-arm64": "49b431dbbefc754b761898672f6a89cadff088f89d75b80796ef08872e7e9e55",
  "win32-x64": "bbe63ab4a501677fe9780242f70a5a66f24fb1e1677134a18eb334da3f58cb87",
  "win32-x86": "189776c5aa9fa14c8a1b61ae92436dfb187d82a364403c78932276d76a6d058e",
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

async function downloadArchive(asset, destination, { fetch = globalThis.fetch, signal } = {}) {
  signal ??= AbortSignal.timeout(120000);
  let response;
  try {
    response = await fetch(asset.url, { signal });
  } catch (error) {
    if (signal.aborted || !(error instanceof TypeError && error.message === "fetch failed"))
      throw error;
  }
  if (!response || [408, 429].includes(response.status) || response.status >= 500) {
    signal.throwIfAborted();
    await response?.body?.cancel();
    const metadata = await fetch(`${API}/tags/${RELEASE}`, {
      headers: { Accept: "application/vnd.github+json" },
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
      headers: { Accept: "application/octet-stream" },
      signal,
    });
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
    await download(asset, archive, { fetch, signal });
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
      throw new Error("The original installer did not produce a complete Python 3.15.1 cache");
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
