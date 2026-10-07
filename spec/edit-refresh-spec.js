const { recordRequest, settle } = require("./request-fixture");
let VariablesStore;
function kernel() {
  const requests = [];
  const idle = new Set();
  return {
    language: "python",
    executionCount: 3,
    lastExecutionTime: "unchanged",
    destroyed: false,
    requests,
    idle,
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle(callback) {
      idle.add(callback);
      return {
        dispose: () => idle.delete(callback),
      };
    },
    emitIdle() {
      for (const callback of [...idle]) callback();
    },
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function snapshot(request, value = 0) {
  request.receive({
    output_type: "stream",
    name: "stdout",
    text: JSON.stringify([
      {
        name: "value",
        type: "int",
        repr: {
          text: String(value),
        },
      },
    ]),
  });
  request.receive({
    output_type: "status",
    execution_state: "idle",
  });
}
function edited(request, idleFirst = false) {
  const idle = {
    output_type: "status",
    execution_state: "idle",
  };
  const reply = {
    stream: "status",
    data: "ok",
  };
  request.receive(idleFirst ? idle : reply);
  request.receive(idleFirst ? reply : idle);
}
describe("edit refresh coalescing", () => {
  let source;
  let store;
  const scans = () => source.requests.filter((request) => request.watch);
  const edits = () => source.requests.filter((request) => !request.watch);
  function enableAuto() {
    store.toggleAutoRefresh();
    snapshot(scans()[0]);
  }
  beforeEach(() => {
    VariablesStore = require("../lib/variables-store").VariablesStore;
    source = kernel();
    store = new VariablesStore(source);
  });
  afterEach(() => store.destroy());
  it("uses the Auto idle scan for an edit in either protocol channel order", async () => {
    enableAuto();
    await settle();
    for (const idleFirst of [false, true]) {
      const before = scans().length;
      store.editVariable("value", "42");
      await settle();
      edited(edits().at(-1), idleFirst);
      await settle();
      expect(scans().length).toBe(before);
      expect(store.refreshing).toBe(true);
      source.emitIdle();
      await settle();
      expect(scans().length).toBe(before + 1);
      snapshot(scans().at(-1), 42);
      await settle();
      window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
      await settle();
      expect(scans().length).toBe(before + 1);
      expect(store.refreshing).toBe(false);
    }
  });
  it("does not add a fallback when Auto refreshed after idle but before a late shell reply", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    const edit = edits()[0];
    edit.receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    window.advanceClock(200);
    await settle();
    source.emitIdle();
    await settle();
    snapshot(scans().at(-1), 42);
    await settle();
    window.advanceClock(150);
    await settle();
    edit.receive({
      stream: "status",
      data: "ok",
    });
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.variables[0].repr.text).toBe("42");
  });
  it("keeps the fallback when a scan after the edit's idle failed", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    const edit = edits()[0];
    edit.receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    source.emitIdle();
    await settle();
    scans().at(-1).receive({
      output_type: "error",
      evalue: "temporarily unavailable",
    });
    await settle();
    edit.receive({
      stream: "status",
      data: "ok",
    });
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS);
    await settle();
    expect(scans().length).toBe(3);
  });
  it("refreshes once through the fallback when a watch suppresses the idle notification", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS - 1);
    await settle();
    expect(scans().length).toBe(1);
    window.advanceClock(1);
    await settle();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(2);
  });
  it("lets a manual refresh consume the edit fallback", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    store.fetchVariables();
    await settle();
    snapshot(scans().at(-1), 42);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
  });
  it("coalesces concurrent completed edits into one bounded fallback", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "41");
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    window.advanceClock(150);
    await settle();
    edited(edits()[1], true);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS - 1);
    await settle();
    expect(scans().length).toBe(1);
    window.advanceClock(1);
    await settle();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    await settle();
    expect(store.variables[0].repr.text).toBe("42");
  });
  it("queues only one trailing scan for many idle and manual requests during a scan", async () => {
    store.toggleAutoRefresh();
    await settle();
    for (let index = 0; index < 5; index++) {
      source.emitIdle();
      await settle();
      store.fetchVariables();
      await settle();
    }
    expect(scans().length).toBe(1);
    snapshot(scans()[0], 1);
    await settle();
    expect(store.refreshing).toBe(true);
    await Promise.resolve();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 2);
    await settle();
    await Promise.resolve();
    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("2");
    expect(store.refreshing).toBe(false);
  });
  it("does not lose an edit refresh behind an older namespace scan", async () => {
    store.toggleAutoRefresh();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    source.emitIdle();
    await settle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    snapshot(scans()[0], 0);
    await settle();
    await Promise.resolve();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("42");
  });
  it("consumes a trailing invalidation after a failed scan without reopening the old latch", async () => {
    store.toggleAutoRefresh();
    await settle();
    source.emitIdle();
    await settle();
    const previous = scans()[0];
    previous.receive({
      output_type: "error",
      evalue: "scan failed",
    });
    await settle();
    await Promise.resolve();
    expect(scans().length).toBe(2);
    previous.receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(store._fetching).toBe(true);
    snapshot(scans()[1], 42);
    await settle();
    expect(store.lastRefreshError).toBeNull();
  });
  it("keeps foreign and silent idle changes authoritative even with unchanged cache metadata", async () => {
    enableAuto();
    await settle();
    const count = store.cachedExecutionCount;
    const time = store.cachedExecutionTime;
    source.emitIdle();
    await settle();
    snapshot(scans()[1], 42);
    await settle();
    expect(source.executionCount).toBe(count);
    expect(source.lastExecutionTime).toBe(time);
    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("42");
  });
  it("cancels a hidden panel's fallback and refreshes when it is shown again", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    store.setActive(false);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.refreshing).toBe(false);
    store.setActive(true);
    await settle();
    expect(scans().length).toBe(2);
  });
  it("does not arm an automatic fallback when the edit completes after hiding", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    store.setActive(false);
    await settle();
    edited(edits()[0]);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
  });
  it("cancels queued and timed refreshes on destroy", async () => {
    store.toggleAutoRefresh();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    source.emitIdle();
    await settle();
    snapshot(scans()[0]);
    store.destroy();
    await settle();
    await Promise.resolve();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.refreshing).toBe(false);
    expect(source.idle.size).toBe(0);
  });
  it("refreshes immediately when Auto is switched off during the fallback", async () => {
    enableAuto();
    await settle();
    store.editVariable("value", "42");
    await settle();
    edited(edits()[0]);
    await settle();
    store.toggleAutoRefresh();
    await settle();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    await settle();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    await settle();
    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
    expect(source.idle.size).toBe(0);
  });
  it("preserves explicit Auto-off edit refreshes even after the panel hides", async () => {
    store.editVariable("value", "42");
    await settle();
    store.setActive(false);
    await settle();
    edited(edits()[0]);
    await settle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
  });
});
