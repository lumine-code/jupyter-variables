const { VariablesStore } = require("../lib/variables-store");
const { recordRequest, generationKernel, settle } = require("./request-fixture");

function kernel() {
  return generationKernel({
    language: "python",
    requests: [],
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle: () => ({ dispose() {} }),
  });
}
describe("owned namespace requests", () => {
  it("disposes an outstanding read when its visible owner goes away", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    const request = source.requests[0];
    store.setActive(false);
    await settle();
    expect(request.disposed).toBe(true);
    expect(store.refreshing).toBe(false);
    store.destroy();
  });
  it("keeps the last namespace on a timed out refresh", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.setVariables([{ name: "cached", repr: { text: "42" } }]);
    store.fetchVariables();
    source.requests[0].finish({ status: "timeout" });
    await settle();
    expect(store.variables[0].name).toBe("cached");
    expect(store.lastRefreshError).toContain("timeout");
    expect(store.refreshing).toBe(false);
    store.destroy();
  });
  it("retires both read and edit observations when the session generation changes", async () => {
    const source = kernel();
    const store = new VariablesStore(source);
    store.fetchVariables();
    store.editVariable("value", "42");
    source.advanceGeneration();
    await settle();
    expect(source.requests.every((request) => request.disposed)).toBe(true);
    expect(store.cachedAt).toBeNull();
    expect(store.variables).toEqual([]);
    expect(store.refreshing).toBe(false);
    store.destroy();
  });
});
