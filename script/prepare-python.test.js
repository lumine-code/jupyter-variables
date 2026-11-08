"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  VERSION,
  RELEASE,
  CHECKSUMS,
  selectAsset,
  downloadArchive,
  preparePython,
} = require("./prepare-python");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jupyter-python-transport-test-"));
  t.after(() => {
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(real).startsWith("jupyter-python-transport-test-"));
    fs.rmSync(real, { recursive: true, force: true });
  });
  return root;
}

const bytes = Buffer.from("an official archive transport fixture");
const asset = {
  ...selectAsset("win32", "x64"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

function transport(initial, metadata) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      if (initial instanceof Error) throw initial;
      return initial;
    }
    if (requests.length === 2)
      return Response.json(
        metadata ?? {
          tag_name: RELEASE,
          assets: [
            {
              id: 123,
              name: asset.filename,
              browser_download_url: asset.url,
              digest: `sha256:${asset.sha256}`,
            },
          ],
        },
      );
    return new Response(bytes);
  };
  return { fetch, requests };
}

test("pinned distributions retain the requested release and official checksums", () => {
  assert.equal(VERSION, "3.15.1");
  assert.equal(RELEASE, "3.15.1-39619321210");
  assert.equal(Object.keys(CHECKSUMS).length, 11);
  for (const [target, digest] of Object.entries(CHECKSUMS)) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.ok(!target.includes("freethreaded"));
  }
  assert.match(
    selectAsset("linux", "x64", 'ID=ubuntu\nVERSION_ID="26.04"\n').filename,
    /linux-26\.04-x64\.tar\.gz$/,
  );
  assert.match(selectAsset("darwin", "arm64").filename, /darwin-arm64\.tar\.gz$/);
  assert.match(selectAsset("win32", "ia32").filename, /win32-x86\.zip$/);
});

test("unsupported distributions cannot silently select another Python build", () => {
  assert.throws(() => selectAsset("linux", "x64", "ID=debian\nVERSION_ID=13"), /requires Ubuntu/);
  assert.throws(() => selectAsset("linux", "x64", "ID=ubuntu\nVERSION_ID=99.04"), /No verified/);
  assert.throws(() => selectAsset("win32", "unknown"), /No verified/);
});

test("a successful primary download is verified without contacting an alternative host", async (t) => {
  const destination = path.join(fixture(t), "python.zip");
  const remote = transport(new Response(bytes));
  await downloadArchive(asset, destination, remote);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].url, asset.url);
});

for (const status of [408, 429, 500, 504, 599]) {
  test(`HTTP ${status} downloads exactly the pinned official API asset`, async (t) => {
    const destination = path.join(fixture(t), "python.zip");
    const primary = new Response("temporary download failure", { status });
    const remote = transport(primary);
    await downloadArchive(asset, destination, remote);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    assert.equal(primary.bodyUsed, true);
    assert.deepEqual(
      remote.requests.map(({ url }) => url),
      [
        asset.url,
        `https://api.github.com/repos/actions/python-versions/releases/tags/${RELEASE}`,
        "https://api.github.com/repos/actions/python-versions/releases/assets/123",
      ],
    );
    assert.deepEqual(remote.requests[1].options.headers, { Accept: "application/vnd.github+json" });
    assert.deepEqual(remote.requests[2].options.headers, { Accept: "application/octet-stream" });
    assert.equal(remote.requests[0].options.signal, remote.requests[2].options.signal);
  });
}

test("a native network failure can use the same verified official asset", async (t) => {
  const remote = transport(new TypeError("fetch failed"));
  await downloadArchive(asset, path.join(fixture(t), "python.zip"), remote);
  assert.equal(remote.requests.length, 3);
});

for (const status of [403, 404]) {
  test(`permanent primary HTTP ${status} does not try another transport`, async (t) => {
    const destination = path.join(fixture(t), "python.zip");
    const remote = transport(new Response(null, { status }));
    await assert.rejects(downloadArchive(asset, destination, remote), new RegExp(`HTTP ${status}`));
    assert.equal(remote.requests.length, 1);
    assert.equal(fs.existsSync(destination), false);
  });
}

test("cancellation and unrelated exceptions do not start an API request", async (t) => {
  const destination = path.join(fixture(t), "python.zip");
  const controller = new AbortController();
  controller.abort();
  const remote = transport(new TypeError("fetch failed"));
  await assert.rejects(
    downloadArchive(asset, destination, { ...remote, signal: controller.signal }),
  );
  assert.equal(remote.requests.length, 1);
  const denied = transport(new Error("permission denied"));
  await assert.rejects(downloadArchive(asset, destination, denied), /permission denied/);
  assert.equal(denied.requests.length, 1);
});

test("cancellation while resolving release metadata prevents the asset transfer", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  const fetch = async () => {
    if (++requests === 1) return new Response(null, { status: 504 });
    controller.abort();
    return Response.json({
      tag_name: RELEASE,
      assets: [
        {
          id: 123,
          name: asset.filename,
          browser_download_url: asset.url,
          digest: `sha256:${asset.sha256}`,
        },
      ],
    });
  };
  await assert.rejects(
    downloadArchive(asset, path.join(fixture(t), "python.zip"), {
      fetch,
      signal: controller.signal,
    }),
  );
  assert.equal(requests, 2);
});

for (const change of [
  { tag_name: "3.15.0-old" },
  { assets: [] },
  { id: -1 },
  { id: "123" },
  { name: "different.zip" },
  { browser_download_url: "https://another.example/python.zip" },
  { digest: "sha256:" + "0".repeat(64) },
]) {
  test(`mismatched release metadata cannot choose an archive: ${JSON.stringify(change)}`, async (t) => {
    const entry = {
      id: 123,
      name: asset.filename,
      browser_download_url: asset.url,
      digest: `sha256:${asset.sha256}`,
    };
    const metadata = {
      tag_name: RELEASE,
      assets: [{ ...entry, ...change }],
      ...("tag_name" in change || "assets" in change ? change : {}),
    };
    const remote = transport(new Response(null, { status: 504 }), metadata);
    await assert.rejects(
      downloadArchive(asset, path.join(fixture(t), "python.zip"), remote),
      /does not match/,
    );
    assert.equal(remote.requests.length, 2);
  });
}

test("corrupt archive bytes are rejected before extraction or cache installation", async (t) => {
  const remote = transport(new Response("corrupt archive"));
  await assert.rejects(
    downloadArchive(asset, path.join(fixture(t), "python.zip"), remote),
    /checksum mismatch/,
  );
  assert.equal(remote.requests.length, 1);
});

test("the bootstrap refuses to execute the original system installer outside Actions", async () => {
  await assert.rejects(preparePython({ env: {} }), /only run on a GitHub Actions runner/);
});

function runner(t, platform) {
  const root = fixture(t),
    temp = path.join(root, "temp"),
    cache = path.join(root, "cache");
  fs.mkdirSync(temp);
  const env = { GITHUB_ACTIONS: "true", RUNNER_TEMP: temp, RUNNER_TOOL_CACHE: cache };
  const target = path.join(cache, "Python", VERSION, "x64");
  const binary = path.join(target, platform === "win32" ? "python.exe" : "bin/python");
  const populate = () => {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture interpreter");
    fs.writeFileSync(`${target}.complete`, "original installer fixture marker");
  };
  return { env, target, binary, temp, populate };
}

test("a complete exact-version cache performs no download or installation", async (t) => {
  const cache = runner(t, "win32");
  cache.populate();
  let probes = 0;
  const result = await preparePython({
    env: cache.env,
    platform: "win32",
    arch: "x64",
    run(command, args, options) {
      assert.equal(command, cache.binary);
      assert.equal(options.capture, true);
      probes++;
      return VERSION + "\n";
    },
    download() {
      assert.fail("A complete cache must not download Python");
    },
  });
  assert.deepEqual(result, { cached: true, target: cache.target });
  assert.equal(probes, 1);
  assert.deepEqual(fs.readdirSync(cache.temp), []);
});

test("a marker belonging to a wrong-version interpreter cannot bypass installation", async (t) => {
  const cache = runner(t, "win32");
  cache.populate();
  let downloaded = false;
  await assert.rejects(
    preparePython({
      env: cache.env,
      platform: "win32",
      arch: "x64",
      run() {
        return "3.15.0";
      },
      download() {
        downloaded = true;
        throw new Error("requires a verified replacement");
      },
    }),
    /requires a verified replacement/,
  );
  assert.equal(downloaded, true);
  assert.deepEqual(fs.readdirSync(cache.temp), []);
});

for (const platform of ["win32", "linux", "darwin"]) {
  test(`${platform} uses the original platform bootstrap and requires its real cache marker`, async (t) => {
    const cache = runner(t, platform),
      calls = [];
    const result = await preparePython({
      env: cache.env,
      platform,
      arch: "x64",
      osRelease: "ID=ubuntu\nVERSION_ID=26.04",
      download(selected, archive) {
        calls.push("download");
        assert.ok(selected.filename.startsWith(`python-${VERSION}-`));
        fs.writeFileSync(archive, "verified download fixture");
      },
      run(command, args, options) {
        if (command === cache.binary) return VERSION;
        if (args.includes("./setup.sh") || args.includes("./setup.ps1")) {
          calls.push("install");
          assert.equal(command, platform === "win32" ? "powershell" : "bash");
          assert.deepEqual(args, [platform === "win32" ? "./setup.ps1" : "./setup.sh"]);
          assert.ok(options.cwd.startsWith(cache.temp + path.sep));
          assert.equal(options.env.RUNNER_TOOL_CACHE, cache.env.RUNNER_TOOL_CACHE);
          if (platform === "linux")
            assert.equal(options.env.LD_LIBRARY_PATH, path.join(options.cwd, "lib"));
          cache.populate();
        } else {
          calls.push("extract");
          assert.equal(command, platform === "win32" ? "powershell" : "tar");
        }
      },
    });
    assert.equal(result.cached, false);
    assert.deepEqual(calls, ["download", "extract", "install"]);
    assert.equal(fs.existsSync(`${cache.target}.complete`), true);
    assert.deepEqual(fs.readdirSync(cache.temp), []);
  });
}

test("a successful bootstrap process cannot manufacture a complete cache implicitly", async (t) => {
  const cache = runner(t, "win32");
  await assert.rejects(
    preparePython({
      env: cache.env,
      platform: "win32",
      arch: "x64",
      download(selected, archive) {
        fs.writeFileSync(archive, "verified fixture");
      },
      run() {},
    }),
    /did not produce a complete/,
  );
  assert.equal(fs.existsSync(`${cache.target}.complete`), false);
  assert.deepEqual(fs.readdirSync(cache.temp), []);
});

test("cancellation after the verified download cannot start extraction or the system installer", async (t) => {
  const cache = runner(t, "win32");
  const controller = new AbortController();
  await assert.rejects(
    preparePython({
      env: cache.env,
      platform: "win32",
      arch: "x64",
      signal: controller.signal,
      download() {
        controller.abort();
      },
      run() {
        assert.fail("Cancellation must prevent extraction and installation");
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(fs.existsSync(`${cache.target}.complete`), false);
  assert.deepEqual(fs.readdirSync(cache.temp), []);
});

test("download and original-installer failures clean only the owned staging directory", async (t) => {
  for (const failure of ["download", "install"]) {
    const cache = runner(t, "win32");
    const sentinel = path.join(cache.temp, "unrelated-file");
    fs.writeFileSync(sentinel, "preserve me");
    await assert.rejects(
      preparePython({
        env: cache.env,
        platform: "win32",
        arch: "x64",
        download(selected, archive) {
          if (failure === "download") throw new Error("download failed");
          fs.writeFileSync(archive, "verified fixture");
        },
        run(command, args) {
          if (args.includes("./setup.ps1")) throw new Error("install failed");
        },
      }),
      new RegExp(`${failure} failed`),
    );
    assert.deepEqual(fs.readdirSync(cache.temp), ["unrelated-file"]);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve me");
    assert.equal(fs.existsSync(`${cache.target}.complete`), false);
  }
});
