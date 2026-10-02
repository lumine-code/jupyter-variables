const { VariablesStore } = require("../lib/variables-store");
const VariablesSession = require("../lib/variables-session");

function kernel() {
  const requests = [];
  const idle = new Set();
  return {
    language: "python",
    destroyed: false,
    requests,
    idle,
    executeWatch: (code, receive) => requests.push({ code, receive, watch: true }),
    executeWithCallback: (code, receive) => requests.push({ code, receive, watch: false }),
    onDidBecomeIdle(receive) {
      idle.add(receive);
      return { dispose: () => idle.delete(receive) };
    },
  };
}

function finish(request, name = "value") {
  request.receive({
    output_type: "stream",
    name: "stdout",
    text: JSON.stringify([{ name, type: "int", repr: { text: "42" } }]),
  });
  request.receive({ output_type: "status", execution_state: "idle" });
}

describe("variable request lifetime", () => {
  it("ignores a namespace reply after its store was destroyed", () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    store.destroy();
    finish(source.requests[0]);

    expect(store.variables).toEqual([]);
    expect(store._fetching).toBe(false);
  });

  it("does not let a failed request's late idle release the next request's latch", () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    source.requests[0].receive({ output_type: "error", evalue: "restarted" });
    store.fetchVariables();
    source.requests[0].receive({ output_type: "status", execution_state: "idle" });
    store.fetchVariables();

    expect(source.requests.length).toBe(2);
    finish(source.requests[1], "fresh");
    expect(store.variables[0].name).toBe("fresh");
    store.destroy();
  });

  it("contains synchronous send failures and allows a later refresh", () => {
    const source = kernel();
    const store = new VariablesStore(source);
    spyOn(console, "error");
    spyOn(source, "executeWatch").and.throwError("connection unavailable");
    store.fetchVariables();
    expect(store._fetching).toBe(false);
    source.executeWatch.and.callThrough();
    store.fetchVariables();

    expect(source.requests.length).toBe(1);
    store.destroy();
  });

  it("keeps the previous table when a decoded payload is not a variable array", () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.setVariables([{ name: "previous", repr: { text: "1" } }]);
    store.fetchVariables();
    source.requests[0].receive({ output_type: "stream", name: "stdout", text: '{"invalid":true}' });
    source.requests[0].receive({ output_type: "status", execution_state: "idle" });

    expect(store.filteredVariables[0].name).toBe("previous");
    store.destroy();
  });

  it("waits for both successful execution halves before refreshing an edited variable", () => {
    for (const idleFirst of [false, true]) {
      const source = kernel();
      const store = new VariablesStore(source);
      store.editVariable("value", "42");
      const edit = source.requests[0];
      edit.receive({ output_type: "status", execution_state: "busy" });
      expect(source.requests.length).toBe(1);
      const idle = { output_type: "status", execution_state: "idle" };
      const reply = { stream: "status", data: "ok" };
      edit.receive(idleFirst ? idle : reply);
      expect(source.requests.length).toBe(1);
      edit.receive(idleFirst ? reply : idle);
      expect(source.requests.length).toBe(2);
      expect(source.requests[1].watch).toBe(true);
      store.destroy();
    }
  });

  it("quotes namespace names that are not Python identifiers", () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.editVariable("name-with-dashes", "42");

    expect(source.requests[0].code).toBe('globals()["name-with-dashes"] = 42');
    store.destroy();
  });
});

describe("visible namespace refresh ownership", () => {
  let session;
  beforeEach(() => (session = new VariablesSession()));
  afterEach(() => session.destroy());

  it("refreshes only the kernel whose table is currently visible", () => {
    const previous = kernel();
    const current = kernel();
    session.setKernel(previous);
    session.setViewActive(true);
    const previousStore = session.storeFor();
    previousStore.toggleAutoRefresh();
    finish(previous.requests[0]);
    expect(previous.idle.size).toBe(1);

    session.setKernel(current);
    const currentStore = session.storeFor();
    currentStore.toggleAutoRefresh();
    finish(current.requests[0]);
    expect(previous.idle.size).toBe(0);
    expect(current.idle.size).toBe(1);

    session.setKernel(previous);
    expect(previous.idle.size).toBe(1);
    expect(current.idle.size).toBe(0);
    expect(previous.requests.length).toBe(2);
  });

  it("releases stores owned by a removed kernel provider", () => {
    const source = kernel();
    const provider = {
      getActiveKernel: () => source,
      onDidChangeKernel: () => ({ dispose() {} }),
      onDidRemoveKernel: () => ({ dispose() {} }),
    };
    session.setProvider(provider);
    session.setViewActive(true);
    const store = session.storeFor();
    store.toggleAutoRefresh();
    session.setProvider(null);
    finish(source.requests[0]);

    expect(session.stores.size).toBe(0);
    expect(source.idle.size).toBe(0);
    expect(store.destroyed).toBe(true);
  });

  it("rebinds a replaced namespace store even when the provider returns the same kernel", () => {
    const source = kernel();
    const provider = () => ({
      getActiveKernel: () => source,
      onDidChangeKernel: () => ({ dispose() {} }),
      onDidRemoveKernel: () => ({ dispose() {} }),
    });
    session.setProvider(provider());
    const previous = session.storeFor();
    const updated = jasmine.createSpy("kernel context updated");
    session.onDidChangeCurrentKernel(updated);
    session.setProvider(provider());

    expect(updated).toHaveBeenCalledTimes(1);
    expect(session.storeFor()).not.toBe(previous);
    expect(previous.destroyed).toBe(true);
  });
});
