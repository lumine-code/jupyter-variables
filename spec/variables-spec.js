const { recordRequest, settle } = require("./request-fixture");
const etch = require("@lumine-code/etch");
const Variables = require("../lib/variables");
const VariablesSession = require("../lib/variables-session");
const { VariablesStore, VARIABLES_CODE } = require("../lib/variables-store");
const VariablesPane = require("../lib/variables-pane");

// This panel used to read a store hung off jupyter-repl's internal Kernel
// objects. It only ever sees a wrapper now, so the fake below offers exactly
// the surface `jupyter.kernel` documents and nothing else.

const flush = (component) => etch.updateSync(component);
function fakeKernel(language = "python") {
  return {
    displayName: "Python 3",
    language,
    destroyed: false,
    executed: [],
    idleCallbacks: [],
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle(callback) {
      this.idleCallbacks.push(callback);
      return {
        dispose: () => this.idleCallbacks.splice(this.idleCallbacks.indexOf(callback), 1),
      };
    },
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function fakeProvider(kernel = null) {
  const listeners = {
    kernel: [],
    removed: [],
  };
  return {
    listeners,
    getActiveKernel: () => kernel,
    onDidChangeKernel(callback) {
      listeners.kernel.push(callback);
      return {
        dispose: () => {},
      };
    },
    onDidRemoveKernel(callback) {
      listeners.removed.push(callback);
      return {
        dispose: () => {},
      };
    },
  };
}
function variables(...names) {
  return names.map((name) => ({
    name,
    type: "int",
    repr: {
      text: "1",
    },
  }));
}
describe("variables store", () => {
  it("asks the kernel for its namespace", async () => {
    const kernel = fakeKernel();
    new VariablesStore(kernel).fetchVariables();
    await settle();
    expect(kernel.executed).toEqual([VARIABLES_CODE]);
  });
  it("shows nothing for a kernel that is not Python", async () => {
    const kernel = fakeKernel("julia");
    const store = new VariablesStore(kernel);
    store.setVariables(variables("df"));
    await settle();
    store.fetchVariables();
    await settle();
    expect(kernel.executed).toEqual([]);
    expect(store.variables).toEqual([]);
  });
  it("reads the names out of the kernel's stdout once the run completes", async () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.fetchVariables();
    await settle();
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: JSON.stringify(variables("df", "total")),
    });
    // Nothing is parsed until the kernel says it is done.
    await settle();
    expect(store.variables).toEqual([]);
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(store.variables.map((v) => v.name)).toEqual(["df", "total"]);
  });
  it("assembles stdout that arrives in chunks", async () => {
    // ipykernel flushes big payloads as several stream messages; parsing any
    // one of them alone would throw the whole namespace away.
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.fetchVariables();
    await settle();
    const text = JSON.stringify(variables("df", "total"));
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: text.slice(0, 10),
    });
    await settle();
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: text.slice(10),
    });
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(store.variables.map((v) => v.name)).toEqual(["df", "total"]);
  });
  it("keeps what it had when the output does not parse", async () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.setVariables(variables("df"));
    await settle();
    store.fetchVariables();
    await settle();
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: "{ truncated",
    });
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(store.variables.map((v) => v.name)).toEqual(["df"]);
  });
  it("releases the latch when the kernel answers with an error", async () => {
    // What a restart or a dead process settles an outstanding fetch with;
    // Refresh must work again afterwards rather than stay latched forever.
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.fetchVariables();
    await settle();
    expect(kernel.executed.length).toBe(1);
    kernel.lastOnResults({
      output_type: "error",
      ename: "ExecutionAborted",
      evalue: "Kernel restarted",
      traceback: [],
    });
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    store.fetchVariables();
    await settle();
    expect(kernel.executed.length).toBe(2);
  });
  it("filters by name", async () => {
    const store = new VariablesStore(fakeKernel());
    store.setVariables(variables("total", "subtotal", "count"));
    await settle();
    store.setFilterText("tot");
    await settle();
    expect(store.filteredVariables.map((v) => v.name)).toEqual(["total", "subtotal"]);
  });
  it("re-reads on every idle only while auto-refresh is on", async () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    expect(kernel.idleCallbacks.length).toBe(0);
    store.toggleAutoRefresh();
    await settle();
    expect(kernel.idleCallbacks.length).toBe(1);
    expect(kernel.executed.length).toBe(1);

    // Complete the first fetch, as a real kernel would.
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    kernel.idleCallbacks[0]();
    await settle();
    expect(kernel.executed.length).toBe(2);
    store.toggleAutoRefresh();
    await settle();
    expect(kernel.idleCallbacks.length).toBe(0);
  });
  it("coalesces idle ticks during a scan into one trailing refresh", async () => {
    // The idle signal is kernel-wide, so a chatty client can tick faster than
    // the namespace dump returns. Only one fetch may be in flight.
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.toggleAutoRefresh();
    await settle();
    expect(kernel.executed.length).toBe(1);
    kernel.idleCallbacks[0]();
    await settle();
    expect(kernel.executed.length).toBe(1);
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    await Promise.resolve();
    expect(kernel.executed.length).toBe(2);
    kernel.idleCallbacks[0]();
    await settle();
    expect(kernel.executed.length).toBe(2);
    store.destroy();
    await settle();
  });
  it("assigns an edited value in the kernel", async () => {
    const kernel = fakeKernel();
    new VariablesStore(kernel).editVariable("total", "42");
    await settle();
    expect(kernel.executed).toEqual(['globals()["total"] = 42']);
  });
  it("refuses to edit through a kernel that is not Python", async () => {
    const kernel = fakeKernel("julia");
    spyOn(lumine.notifications, "addWarning");
    await settle();
    new VariablesStore(kernel).editVariable("total", "42");
    await settle();
    expect(kernel.executed).toEqual([]);
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });
});
describe("variables session", () => {
  let session;
  beforeEach(() => {
    session = new VariablesSession();
  });
  afterEach(() => {
    session.destroy();
  });
  it("takes the active kernel from the provider it is given", async () => {
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));
    await settle();
    expect(session.kernel).toBe(kernel);
  });
  it("keeps one store per kernel", async () => {
    const first = fakeKernel();
    const second = fakeKernel();
    session.setProvider(fakeProvider(first));
    await settle();
    const store = session.storeFor();
    expect(session.storeFor()).toBe(store);
    expect(session.storeFor(second)).not.toBe(store);
  });
  it("drops the store of a kernel that goes away", async () => {
    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    session.setProvider(provider);
    await settle();
    session.setViewActive(true);
    await settle();
    session.storeFor().toggleAutoRefresh();
    await settle();
    expect(kernel.idleCallbacks.length).toBe(1);
    provider.listeners.removed[0](kernel);
    await settle();
    expect(session.kernel).toBe(null);
    expect(kernel.idleCallbacks.length).toBe(0);
  });
  it("lets go of a replaced provider's subscriptions", async () => {
    let disposed = 0;
    const provider = {
      getActiveKernel: () => null,
      onDidChangeKernel: () => ({
        dispose: () => disposed++,
      }),
      onDidRemoveKernel: () => ({
        dispose: () => disposed++,
      }),
    };
    session.setProvider(provider);
    await settle();
    session.setProvider(null);
    await settle();
    expect(disposed).toBe(2);
  });
  it("pauses auto-refresh while no panel is open and resumes on reopen", async () => {
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));
    await settle();
    session.setViewActive(true);
    await settle();
    const store = session.storeFor();
    store.toggleAutoRefresh();
    await settle();
    expect(kernel.idleCallbacks.length).toBe(1);
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    const fetches = kernel.executed.length;
    session.setViewActive(false);
    await settle();
    expect(kernel.idleCallbacks.length).toBe(0);
    expect(store.autoRefresh).toBe(true);
    session.setViewActive(true);
    await settle();
    expect(kernel.idleCallbacks.length).toBe(1);
    // One fresh fetch, so the reopened panel is current rather than stale.
    expect(kernel.executed.length).toBe(fetches + 1);
    await settle();
  });
  it("says nothing to explore when jupyter-explorer is not installed", async () => {
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    expect(() => session.explore(session.kernel, "df")).not.toThrow();
  });
  it("hands a name to jupyter-explorer when it is", async () => {
    const explored = [];
    session.setExplorer({
      explore: (kernel, name) => explored.push(name),
    });
    await settle();
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    session.explore(session.kernel, "df");
    await settle();
    expect(explored).toEqual(["df"]);
  });
});
describe("variables panel", () => {
  let component;
  let session;
  beforeEach(() => {
    session = new VariablesSession();
  });
  afterEach(() => {
    component?.destroy();
    component = null;
    session.destroy();
  });
  function render() {
    component = new Variables({
      store: session,
    });
    flush(component);
    return component;
  }
  it("says so when no kernel is running", async () => {
    render();
    await settle();
    expect(component.element.textContent).toContain("No kernel running");
  });
  it("says so for a kernel that is not Python", async () => {
    session.setProvider(fakeProvider(fakeKernel("julia")));
    await settle();
    render();
    await settle();
    expect(component.element.textContent).toContain("only works with Python kernels");
  });
  it("lists what the kernel reported", async () => {
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    render();
    await settle();
    session.storeFor().setVariables(variables("df", "total"));
    await settle();
    flush(component);
    await settle();
    const names = [...component.element.querySelectorAll(".variable-name")].map((cell) =>
      cell.textContent.trim(),
    );
    expect(names).toEqual(["df", "total"]);
  });
  it("offers a filter field", async () => {
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    render();
    await settle();
    expect(component.element.querySelector(".filter-editor lumine-text-editor")).toBeTruthy();
  });
  it("assigns an edit only when the value actually changed", async () => {
    // A repr is rarely valid Python — a summary line never is — so blurring
    // an untouched field must not execute `name = <repr>` in the kernel.
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));
    await settle();
    render();
    await settle();
    const variable = {
      name: "total",
      type: "int",
      repr: {
        text: "42",
      },
    };
    session.storeFor().setVariables([variable]);
    await settle();
    flush(component);
    await settle();
    component.startEditing(variable);
    await settle();
    component.submitEdit();
    await settle();
    expect(kernel.executed).toEqual([]);
    component.startEditing(variable);
    await settle();
    component.editValue = "43";
    component.submitEdit();
    await settle();
    expect(kernel.executed).toEqual(['globals()["total"] = 43']);
  });
});

// The Python side is what actually guards the kernel; exercise it against a
// real interpreter where one is available.
const { execFileSync } = require("child_process");
function findPython() {
  for (const candidate of ["python3", "python"]) {
    try {
      const version = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (/Python 3/.test(version)) {
        return candidate;
      }
    } catch {
      // Not this one; try the next.
    }
  }
  return null;
}
const python = findPython();
const namespaceSuite = python ? describe : () => {};
namespaceSuite("the namespace dump", () => {
  it("bounds custom rich representations before sending the namespace", async () => {
    const harness = `
import io, json, contextlib
class BigHTML:
    def _repr_html_(self):
        return "<div>" + "x" * 1000000 + "</div>"
    def __repr__(self):
        return "BigHTML(summary)"
ns = {"__name__": "__main__", "__builtins__": __builtins__, "value": BigHTML()}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(${JSON.stringify(VARIABLES_CODE)}, ns)
print(buf.getvalue())
`;
    const result = JSON.parse(
      execFileSync(python, ["-c", harness], {
        encoding: "utf8",
        timeout: 30000,
      }),
    );
    expect(result[0].repr.html).toBeUndefined();
    expect(result[0].repr.text).toBe("BigHTML(summary)");
  });
  it("reads a namespace without disturbing it", async () => {
    const harness = `
import io, json, contextlib
ns = {"__name__": "__main__", "__builtins__": __builtins__}
exec("import math", ns)
ns["big"] = list(range(5000))
ns["small"] = 42
code = ${JSON.stringify(VARIABLES_CODE)}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(code, ns)
rows = json.loads(buf.getvalue())
print(json.dumps({
    "names": sorted(r["name"] for r in rows),
    "big": next(r for r in rows if r["name"] == "big")["repr"]["text"],
    "leaked": sorted(k for k in ns if k in ("json", "base64", "types", "StringIO")),
}))
`;
    const output = execFileSync(python, ["-c", harness], {
      encoding: "utf8",
      timeout: 30000,
    });
    const result = JSON.parse(output);

    // `math` — a module — is skipped; the big list is summarised, not
    // materialised; and the walk's own imports never reach the namespace.
    expect(result.names).toEqual(["big", "small"]);
    await settle();
    expect(result.big).toBe("list(length=5,000)");
    expect(result.leaked).toEqual([]);
  });
});
describe("variables pane teardown", () => {
  // A pane drops an item only when the item tells it so; losing the kernel
  // service destroys the item directly rather than through `pane.destroyItem`.
  it("leaves no tab behind when destroyed directly", async () => {
    const item = new VariablesPane(new VariablesSession());
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    await settle();
    expect(pane.getItems()).toContain(item);
    item.destroy();
    await settle();
    expect(pane.getItems()).not.toContain(item);
  });
  it("survives being destroyed twice", async () => {
    const item = new VariablesPane(new VariablesSession());
    item.destroy();
    await settle();
    expect(() => item.destroy()).not.toThrow();
  });
});
