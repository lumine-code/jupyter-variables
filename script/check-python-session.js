// Exercise the shipped namespace store through jupyter-repl's real public
// kernel wrapper and native transport. Only editor services are substituted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const peerRoot = process.env.LUMINE_TEST_JUPYTER_REPL;
assert(peerRoot, "Set LUMINE_TEST_JUPYTER_REPL to the installed jupyter-repl checkout.");
const peerRequire = Module.createRequire(path.join(path.resolve(peerRoot), "package.json"));
const python = process.env.LUMINE_TEST_PYTHON || "python";
const versions = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      "import sys,json,ipykernel,numpy,pandas,pyarrow; print(json.dumps(dict(python=sys.version.split()[0],ipykernel=ipykernel.__version__,numpy=numpy.__version__,pandas=pandas.__version__,pyarrow=pyarrow.__version__)))",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  ),
);
const { Emitter, Disposable, CompositeDisposable } = peerRequire("@lumine-code/event-kit");
const esbuild = peerRequire("esbuild");
const peerLib = path.join(path.resolve(peerRoot), "lib");
const temporaryParent = fs.realpathSync.native(
  process.env.LUMINE_TEST_TEMP_DIR || process.env.RUNNER_TEMP || os.tmpdir(),
);
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "lumine-variables-ci-"));
const runtimeDir = path.join(temporaryRoot, "runtime");
const ipythonDir = path.join(temporaryRoot, "ipython");
const jupyterConfigDir = path.join(temporaryRoot, "jupyter");
fs.mkdirSync(runtimeDir);
fs.mkdirSync(path.join(ipythonDir, "profile_variables"), { recursive: true });
fs.mkdirSync(jupyterConfigDir);
process.env.TEMP = temporaryRoot;
process.env.TMP = temporaryRoot;
process.env.JUPYTER_RUNTIME_DIR = runtimeDir;
const notifications = [];
const editorStore = {
  editor: null,
  startingKernels: new Map(),
  runningKernels: [],
  deleteKernel(kernel) {
    this.runningKernels = this.runningKernels.filter((candidate) => candidate !== kernel);
  },
};
global.lumine = {
  config: {
    get: (key) => (key === "jupyter-repl.pythonAutoreload" ? "off" : false),
    observe: (_key, callback) => {
      callback(false);
      return new Disposable();
    },
  },
  notifications: Object.fromEntries(
    ["addError", "addWarning", "addInfo"].map((method) => [
      method,
      (title, options) => {
        notifications.push({ method, title, detail: options?.detail ?? options?.description });
        return { dismiss() {} };
      },
    ]),
  ),
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "lumine") return { Emitter, Disposable, CompositeDisposable };
  if (name === "./store" && parent?.filename.startsWith(peerLib + path.sep)) return editorStore;
  return originalLoad.call(this, name, parent, isMain);
};
require.extensions[".jsx"] = (module, filename) => {
  const { code } = esbuild.transformSync(fs.readFileSync(filename, "utf8"), {
    loader: "jsx",
    format: "cjs",
    jsxFactory: "etch.dom",
  });
  module._compile(code, filename);
};

const ZMQKernel = peerRequire("./lib/zmq-kernel");
const Kernel = peerRequire("./lib/kernel");
const { VariablesStore } = require("../lib/variables-store");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let transport;
let kernel;
let store;

async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) await wait(10);
  assert(predicate(), message);
}

async function start() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Python kernel startup timed out: ${JSON.stringify(notifications)}`)),
      30000,
    );
    const environment = {
      ...process.env,
      IPYTHONDIR: ipythonDir,
      JUPYTER_CONFIG_DIR: jupyterConfigDir,
      PYTHONSTARTUP: "",
    };
    transport = new ZMQKernel(
      {
        name: "python3",
        display_name: "Owned variables Python",
        language: "python",
        argv: [
          python,
          "-m",
          "ipykernel_launcher",
          "-f",
          "{connection_file}",
          `--IPKernelApp.ipython_dir=${ipythonDir}`,
          "--IPKernelApp.profile=variables",
          `--HistoryManager.hist_file=${path.join(temporaryRoot, "history.sqlite")}`,
        ],
      },
      { name: "Python", scopeName: "source.python" },
      { cwd: temporaryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
    const lifecycle = transport.onDidChangeLifecycle((state) => {
      if (["dead", "unresponsive"].includes(state)) {
        clearTimeout(timer);
        lifecycle.dispose();
        reject(new Error(`Python kernel startup failed: ${state}`));
      } else if (state === "ready") lifecycle.dispose();
    });
  });
  kernel = new Kernel(transport);
  editorStore.runningKernels.push(kernel);
  return kernel.getPluginWrapper();
}

async function execute(api, code, purpose = "user") {
  const request = api.request({ type: "execute", purpose, code, timeoutMs: 15000 });
  try {
    const result = await request.done;
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result;
  } finally {
    request.dispose();
  }
}

async function refresh() {
  const previous = store._successfulRefreshRevision;
  store.fetchVariables();
  await until(
    () => !store.refreshing && store._successfulRefreshRevision > previous,
    `Namespace did not refresh: ${store.lastRefreshError}`,
  );
  assert.equal(store.lastRefreshError, null);
}

async function run() {
  const api = await start();
  store = new VariablesStore(api);
  await execute(
    api,
    `import numpy as np, pandas as pd, pyarrow as pa
from IPython.display import HTML, Image, Markdown
import base64
array = np.arange(6).reshape(2, 3)
frame = pd.DataFrame({'value': [1, 2], 'label': ['zażółć', '😀']})
arrow_table = pa.Table.from_pandas(frame)
large_frame = pd.DataFrame({'value': np.arange(11001)})
html = HTML('<strong>live namespace</strong>')
markdown = Markdown('**live markdown**')
image = Image(data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), format='png')
total = 41
_get_variables = object()
_owned_helper = _get_variables
_expected_names = set(globals())
_expected_names.add('_expected_names')`,
  );
  const executionCount = api.executionCount;
  await refresh();
  assert.equal(api.executionCount, executionCount, "Namespace queries must not enter cell history");
  const values = Object.fromEntries(store.variables.map((value) => [value.name, value]));
  assert.equal(values.array.type, "ndarray");
  assert.equal(values.array.repr.text, "array(shape=(2, 3), dtype=int64)");
  assert(values.array.repr.pretty.includes("[0, 1, 2]"));
  assert.equal(values.frame.type, "DataFrame");
  assert(values.frame.repr.html.includes("zażółć"));
  assert(values.frame.repr.html.includes("😀"));
  assert.equal(values.arrow_table.type, "Table");
  assert.equal(values.large_frame.repr.text, "DataFrame(11,001 rows × 1 cols)");
  assert.equal(values.large_frame.repr.html, undefined);
  assert.equal(values.html.repr.html, "<strong>live namespace</strong>");
  assert.equal(values.markdown.repr.markdown, "**live markdown**");
  assert(
    Buffer.from(values.image.repr.png, "base64")
      .subarray(0, 4)
      .equals(Buffer.from([137, 80, 78, 71])),
  );
  assert.equal(values.np, undefined);
  assert.equal(values._get_variables, undefined);
  await execute(
    api,
    "assert _get_variables is _owned_helper\nassert set(globals()) == _expected_names",
    "query",
  );
  store.setFilterText("fram");
  assert.deepEqual(store.filteredVariables.map((value) => value.name).sort(), [
    "frame",
    "large_frame",
  ]);

  store.editVariable("total", "42");
  await until(
    () =>
      !store.refreshing &&
      store.variables.find((value) => value.name === "total")?.repr.text === "42",
    "Edited value did not return through the real namespace request",
  );
  await execute(api, "assert total == 42", "query");
  store.toggleAutoRefresh();
  await until(() => !store.refreshing, "Initial automatic scan did not settle");
  await execute(api, "total = 43");
  await until(
    () =>
      !store.refreshing &&
      store.variables.find((value) => value.name === "total")?.repr.text === "43",
    "A real cell's idle notification did not refresh the namespace",
  );
  store.toggleAutoRefresh();
  const oldProcess = transport.kernelProcess;
  assert.equal(await api.restart(), true);
  assert(oldProcess.exitCode !== null || oldProcess.signalCode !== null);
  assert.deepEqual(store.variables, []);
  assert.equal(store.cachedAt, null);
  await execute(api, "fresh_value = 99");
  await refresh();
  assert.equal(store.variables.find((value) => value.name === "fresh_value")?.repr.text, "99");
  assert(!store.variables.some((value) => value.name === "total"));
  console.log(
    JSON.stringify({ ...versions, namespace: "ok", edit: "ok", idle: "ok", restart: "ok" }),
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    store?.destroy();
    const child = transport?.kernelProcess;
    const connectionFile = transport?.connectionFile;
    if (kernel) await kernel.shutdownAndDestroy();
    else transport?.destroy();
    if (child) await transport._killProcessTree(child);
    if (kernel) {
      assert.equal(kernel._inFlight.size, 0);
      assert.equal(kernel.watchCallbacks.length, 0);
      assert.equal(transport.shellSocket, null);
      assert.equal(transport.ioSocket, null);
      assert.equal(transport.stdinSocket, null);
      assert(!fs.existsSync(connectionFile));
      assert(child.exitCode !== null || child.signalCode !== null);
    }
    assert.equal(editorStore.runningKernels.length, 0);
    assert.deepEqual(fs.readdirSync(runtimeDir), []);
    assert.deepEqual(notifications, []);
    if (path.dirname(path.resolve(temporaryRoot)) !== path.resolve(temporaryParent)) {
      throw new Error("Unexpected owned test directory; refusing cleanup");
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
