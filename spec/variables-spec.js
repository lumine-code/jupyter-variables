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
    executed: [],
    idleCallbacks: [],
    executeWatch(code, onResults) {
      this.executed.push(code);
      this.lastOnResults = onResults;
    },
    executeWithCallback(code, onResults) {
      this.executed.push(code);
      this.lastOnResults = onResults;
    },
    onDidBecomeIdle(callback) {
      this.idleCallbacks.push(callback);
      return { dispose: () => this.idleCallbacks.splice(this.idleCallbacks.indexOf(callback), 1) };
    },
  };
}

function fakeProvider(kernel = null) {
  const listeners = { kernel: [], removed: [] };
  return {
    listeners,
    getActiveKernel: () => kernel,
    onDidChangeKernel(callback) {
      listeners.kernel.push(callback);
      return { dispose: () => {} };
    },
    onDidRemoveKernel(callback) {
      listeners.removed.push(callback);
      return { dispose: () => {} };
    },
  };
}

function variables(...names) {
  return names.map((name) => ({ name, type: "int", repr: { text: "1" } }));
}

describe("variables store", () => {
  it("asks the kernel for its namespace", () => {
    const kernel = fakeKernel();
    new VariablesStore(kernel).fetchVariables();

    expect(kernel.executed).toEqual([VARIABLES_CODE]);
  });

  it("shows nothing for a kernel that is not Python", () => {
    const kernel = fakeKernel("julia");
    const store = new VariablesStore(kernel);
    store.setVariables(variables("df"));

    store.fetchVariables();

    expect(kernel.executed).toEqual([]);
    expect(store.variables).toEqual([]);
  });

  it("reads the names out of the kernel's stdout", () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.fetchVariables();

    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: JSON.stringify(variables("df", "total")),
    });

    expect(store.variables.map((v) => v.name)).toEqual(["df", "total"]);
  });

  it("keeps what it had when the output does not parse", () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);
    store.setVariables(variables("df"));
    store.fetchVariables();

    kernel.lastOnResults({ output_type: "stream", name: "stdout", text: "{ truncated" });

    expect(store.variables.map((v) => v.name)).toEqual(["df"]);
  });

  it("filters by name", () => {
    const store = new VariablesStore(fakeKernel());
    store.setVariables(variables("total", "subtotal", "count"));

    store.setFilterText("tot");

    expect(store.filteredVariables.map((v) => v.name)).toEqual(["total", "subtotal"]);
  });

  it("re-reads on every idle only while auto-refresh is on", () => {
    const kernel = fakeKernel();
    const store = new VariablesStore(kernel);

    expect(kernel.idleCallbacks.length).toBe(0);

    store.toggleAutoRefresh();
    expect(kernel.idleCallbacks.length).toBe(1);
    expect(kernel.executed.length).toBe(1);

    kernel.idleCallbacks[0]();
    expect(kernel.executed.length).toBe(2);

    store.toggleAutoRefresh();
    expect(kernel.idleCallbacks.length).toBe(0);
  });

  it("assigns an edited value in the kernel", () => {
    const kernel = fakeKernel();
    new VariablesStore(kernel).editVariable("total", "42");

    expect(kernel.executed).toEqual(["total = 42"]);
  });

  it("refuses to edit through a kernel that is not Python", () => {
    const kernel = fakeKernel("julia");
    spyOn(lumine.notifications, "addWarning");

    new VariablesStore(kernel).editVariable("total", "42");

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

  it("takes the active kernel from the provider it is given", () => {
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));

    expect(session.kernel).toBe(kernel);
  });

  it("keeps one store per kernel", () => {
    const first = fakeKernel();
    const second = fakeKernel();
    session.setProvider(fakeProvider(first));

    const store = session.storeFor();
    expect(session.storeFor()).toBe(store);
    expect(session.storeFor(second)).not.toBe(store);
  });

  it("drops the store of a kernel that goes away", () => {
    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    session.setProvider(provider);
    session.storeFor().toggleAutoRefresh();

    expect(kernel.idleCallbacks.length).toBe(1);

    provider.listeners.removed[0](kernel);

    expect(session.kernel).toBe(null);
    expect(kernel.idleCallbacks.length).toBe(0);
  });

  it("says nothing to explore when jupyter-explorer is not installed", () => {
    session.setProvider(fakeProvider(fakeKernel()));
    expect(() => session.explore(session.kernel, "df")).not.toThrow();
  });

  it("hands a name to jupyter-explorer when it is", () => {
    const explored = [];
    session.setExplorer({ explore: (kernel, name) => explored.push(name) });
    session.setProvider(fakeProvider(fakeKernel()));

    session.explore(session.kernel, "df");

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
    component = new Variables({ store: session });
    flush(component);
    return component;
  }

  it("says so when no kernel is running", () => {
    render();
    expect(component.element.textContent).toContain("No kernel running");
  });

  it("says so for a kernel that is not Python", () => {
    session.setProvider(fakeProvider(fakeKernel("julia")));
    render();

    expect(component.element.textContent).toContain("only works with Python kernels");
  });

  it("lists what the kernel reported", () => {
    session.setProvider(fakeProvider(fakeKernel()));
    render();
    session.storeFor().setVariables(variables("df", "total"));
    flush(component);

    const names = [...component.element.querySelectorAll(".variable-name")].map((cell) =>
      cell.textContent.trim(),
    );
    expect(names).toEqual(["df", "total"]);
  });

  it("offers a filter field", () => {
    session.setProvider(fakeProvider(fakeKernel()));
    render();

    expect(component.element.querySelector(".filter-editor lumine-text-editor")).toBeTruthy();
  });
});

describe("variables pane teardown", () => {
  // A pane drops an item only when the item tells it so; losing the kernel
  // service destroys the item directly rather than through `pane.destroyItem`.
  it("leaves no tab behind when destroyed directly", () => {
    const item = new VariablesPane(new VariablesSession());
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);

    expect(pane.getItems()).toContain(item);

    item.destroy();

    expect(pane.getItems()).not.toContain(item);
  });

  it("survives being destroyed twice", () => {
    const item = new VariablesPane(new VariablesSession());
    item.destroy();
    expect(() => item.destroy()).not.toThrow();
  });
});
