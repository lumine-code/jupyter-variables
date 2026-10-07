const { recordRequest, settle } = require("./request-fixture");
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
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle(receive) {
      idle.add(receive);
      return {
        dispose: () => idle.delete(receive),
      };
    },
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function finish(request, name = "value") {
  request.receive({
    output_type: "stream",
    name: "stdout",
    text: JSON.stringify([
      {
        name,
        type: "int",
        repr: {
          text: "42",
        },
      },
    ]),
  });
  request.receive({
    output_type: "status",
    execution_state: "idle",
  });
}
describe("variable request lifetime", () => {
  it("ignores a namespace reply after its store was destroyed", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    await settle();
    store.destroy();
    await settle();
    finish(source.requests[0]);
    await settle();
    expect(store.variables).toEqual([]);
    expect(store._fetching).toBe(false);
  });
  it("does not let a failed request's late idle release the next request's latch", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    await settle();
    source.requests[0].receive({
      output_type: "error",
      evalue: "restarted",
    });
    await settle();
    store.fetchVariables();
    await settle();
    source.requests[0].receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    store.fetchVariables();
    await settle();
    expect(source.requests.length).toBe(2);
    finish(source.requests[1], "fresh");
    await settle();
    expect(store.variables[0].name).toBe("fresh");
    store.destroy();
    await settle();
  });
  it("contains synchronous send failures and allows a later refresh", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    spyOn(console, "error");
    await settle();
    spyOn(source, "request").and.throwError("connection unavailable");
    await settle();
    store.fetchVariables();
    await settle();
    expect(store._fetching).toBe(false);
    source.request.and.callThrough();
    await settle();
    store.fetchVariables();
    await settle();
    expect(source.requests.length).toBe(1);
    store.destroy();
    await settle();
  });
  it("keeps the previous table when a decoded payload is not a variable array", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.setVariables([
      {
        name: "previous",
        repr: {
          text: "1",
        },
      },
    ]);
    await settle();
    store.fetchVariables();
    await settle();
    source.requests[0].receive({
      output_type: "stream",
      name: "stdout",
      text: '{"invalid":true}',
    });
    await settle();
    source.requests[0].receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(store.filteredVariables[0].name).toBe("previous");
    store.destroy();
    await settle();
  });
  it("waits for both successful execution halves before refreshing an edited variable", async () => {
    for (const idleFirst of [false, true]) {
      const source = kernel();
      const store = new VariablesStore(source);
      store.editVariable("value", "42");
      await settle();
      const edit = source.requests[0];
      edit.receive({
        output_type: "status",
        execution_state: "busy",
      });
      await settle();
      expect(source.requests.length).toBe(1);
      const idle = {
        output_type: "status",
        execution_state: "idle",
      };
      const reply = {
        stream: "status",
        data: "ok",
      };
      edit.receive(idleFirst ? idle : reply);
      await settle();
      expect(source.requests.length).toBe(1);
      edit.receive(idleFirst ? reply : idle);
      await settle();
      expect(source.requests.length).toBe(2);
      expect(source.requests[1].watch).toBe(true);
      store.destroy();
      await settle();
    }
  });
  it("quotes namespace names that are not Python identifiers", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.editVariable("name-with-dashes", "42");
    await settle();
    expect(source.requests[0].code).toBe('globals()["name-with-dashes"] = 42');
    store.destroy();
    await settle();
  });
});
describe("visible namespace refresh ownership", () => {
  let session;
  beforeEach(() => (session = new VariablesSession()));
  afterEach(() => session.destroy());
  it("refreshes only the kernel whose table is currently visible", async () => {
    const previous = kernel();
    const current = kernel();
    session.setKernel(previous);
    await settle();
    session.setViewActive(true);
    await settle();
    const previousStore = session.storeFor();
    previousStore.toggleAutoRefresh();
    await settle();
    finish(previous.requests[0]);
    await settle();
    expect(previous.idle.size).toBe(1);
    session.setKernel(current);
    await settle();
    const currentStore = session.storeFor();
    currentStore.toggleAutoRefresh();
    await settle();
    finish(current.requests[0]);
    await settle();
    expect(previous.idle.size).toBe(0);
    expect(current.idle.size).toBe(1);
    session.setKernel(previous);
    await settle();
    expect(previous.idle.size).toBe(1);
    expect(current.idle.size).toBe(0);
    expect(previous.requests.length).toBe(2);
  });
  it("releases stores owned by a removed kernel provider", async () => {
    const source = kernel();
    const provider = {
      getActiveKernel: () => source,
      onDidChangeKernel: () => ({
        dispose() {},
      }),
      onDidRemoveKernel: () => ({
        dispose() {},
      }),
    };
    session.setProvider(provider);
    await settle();
    session.setViewActive(true);
    await settle();
    const store = session.storeFor();
    store.toggleAutoRefresh();
    await settle();
    session.setProvider(null);
    await settle();
    finish(source.requests[0]);
    await settle();
    expect(session.stores.size).toBe(0);
    expect(source.idle.size).toBe(0);
    expect(store.destroyed).toBe(true);
  });
  it("rebinds a replaced namespace store even when the provider returns the same kernel", async () => {
    const source = kernel();
    const provider = () => ({
      getActiveKernel: () => source,
      onDidChangeKernel: () => ({
        dispose() {},
      }),
      onDidRemoveKernel: () => ({
        dispose() {},
      }),
    });
    session.setProvider(provider());
    await settle();
    const previous = session.storeFor();
    const updated = jasmine.createSpy("kernel context updated");
    session.onDidChangeCurrentKernel(updated);
    await settle();
    session.setProvider(provider());
    await settle();
    expect(updated).toHaveBeenCalledTimes(1);
    expect(session.storeFor()).not.toBe(previous);
    expect(previous.destroyed).toBe(true);
  });
});
