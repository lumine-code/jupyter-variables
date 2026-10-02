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
    executeWatch: (code, receive) => requests.push({ code, receive, watch: true }),
    executeWithCallback: (code, receive) => requests.push({ code, receive, watch: false }),
    onDidBecomeIdle(callback) {
      idle.add(callback);
      return { dispose: () => idle.delete(callback) };
    },
    emitIdle() {
      for (const callback of [...idle]) callback();
    },
  };
}

function snapshot(request, value = 0) {
  request.receive({
    output_type: "stream",
    name: "stdout",
    text: JSON.stringify([{ name: "value", type: "int", repr: { text: String(value) } }]),
  });
  request.receive({ output_type: "status", execution_state: "idle" });
}

function edited(request, idleFirst = false) {
  const idle = { output_type: "status", execution_state: "idle" };
  const reply = { stream: "status", data: "ok" };
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

  it("uses the Auto idle scan for an edit in either protocol channel order", () => {
    enableAuto();
    for (const idleFirst of [false, true]) {
      const before = scans().length;
      store.editVariable("value", "42");
      edited(edits().at(-1), idleFirst);
      expect(scans().length).toBe(before);
      expect(store.refreshing).toBe(true);
      source.emitIdle();
      expect(scans().length).toBe(before + 1);
      snapshot(scans().at(-1), 42);
      window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
      expect(scans().length).toBe(before + 1);
      expect(store.refreshing).toBe(false);
    }
  });

  it("does not add a fallback when Auto refreshed after idle but before a late shell reply", () => {
    enableAuto();
    store.editVariable("value", "42");
    const edit = edits()[0];
    edit.receive({ output_type: "status", execution_state: "idle" });
    window.advanceClock(200);
    source.emitIdle();
    snapshot(scans().at(-1), 42);
    window.advanceClock(150);
    edit.receive({ stream: "status", data: "ok" });
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.variables[0].repr.text).toBe("42");
  });

  it("keeps the fallback when a scan after the edit's idle failed", () => {
    enableAuto();
    store.editVariable("value", "42");
    const edit = edits()[0];
    edit.receive({ output_type: "status", execution_state: "idle" });
    source.emitIdle();
    scans().at(-1).receive({ output_type: "error", evalue: "temporarily unavailable" });
    edit.receive({ stream: "status", data: "ok" });
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS);

    expect(scans().length).toBe(3);
  });

  it("refreshes once through the fallback when a watch suppresses the idle notification", () => {
    enableAuto();
    store.editVariable("value", "42");
    edited(edits()[0]);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS - 1);
    expect(scans().length).toBe(1);
    window.advanceClock(1);
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    expect(scans().length).toBe(2);
  });

  it("lets a manual refresh consume the edit fallback", () => {
    enableAuto();
    store.editVariable("value", "42");
    edited(edits()[0]);
    store.fetchVariables();
    snapshot(scans().at(-1), 42);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
  });

  it("coalesces concurrent completed edits into one bounded fallback", () => {
    enableAuto();
    store.editVariable("value", "41");
    store.editVariable("value", "42");
    edited(edits()[0]);
    window.advanceClock(150);
    edited(edits()[1], true);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS - 1);
    expect(scans().length).toBe(1);
    window.advanceClock(1);
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    expect(store.variables[0].repr.text).toBe("42");
  });

  it("queues only one trailing scan for many idle and manual requests during a scan", async () => {
    store.toggleAutoRefresh();
    for (let index = 0; index < 5; index++) {
      source.emitIdle();
      store.fetchVariables();
    }
    expect(scans().length).toBe(1);
    snapshot(scans()[0], 1);
    expect(store.refreshing).toBe(true);
    await Promise.resolve();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 2);
    await Promise.resolve();

    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("2");
    expect(store.refreshing).toBe(false);
  });

  it("does not lose an edit refresh behind an older namespace scan", async () => {
    store.toggleAutoRefresh();
    store.editVariable("value", "42");
    edited(edits()[0]);
    source.emitIdle();
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    snapshot(scans()[0], 0);
    await Promise.resolve();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("42");
  });

  it("consumes a trailing invalidation after a failed scan without reopening the old latch", async () => {
    store.toggleAutoRefresh();
    source.emitIdle();
    const previous = scans()[0];
    previous.receive({ output_type: "error", evalue: "scan failed" });
    await Promise.resolve();
    expect(scans().length).toBe(2);
    previous.receive({ output_type: "status", execution_state: "idle" });
    expect(store._fetching).toBe(true);
    snapshot(scans()[1], 42);
    expect(store.lastRefreshError).toBeNull();
  });

  it("keeps foreign and silent idle changes authoritative even with unchanged cache metadata", () => {
    enableAuto();
    const count = store.cachedExecutionCount;
    const time = store.cachedExecutionTime;
    source.emitIdle();
    snapshot(scans()[1], 42);

    expect(source.executionCount).toBe(count);
    expect(source.lastExecutionTime).toBe(time);
    expect(scans().length).toBe(2);
    expect(store.variables[0].repr.text).toBe("42");
  });

  it("cancels a hidden panel's fallback and refreshes when it is shown again", () => {
    enableAuto();
    store.editVariable("value", "42");
    edited(edits()[0]);
    store.setActive(false);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);
    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.refreshing).toBe(false);
    store.setActive(true);
    expect(scans().length).toBe(2);
  });

  it("does not arm an automatic fallback when the edit completes after hiding", () => {
    enableAuto();
    store.editVariable("value", "42");
    store.setActive(false);
    edited(edits()[0]);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
  });

  it("cancels queued and timed refreshes on destroy", async () => {
    store.toggleAutoRefresh();
    store.editVariable("value", "42");
    edited(edits()[0]);
    source.emitIdle();
    snapshot(scans()[0]);
    store.destroy();
    await Promise.resolve();
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
    expect(store.refreshing).toBe(false);
    expect(source.idle.size).toBe(0);
  });

  it("refreshes immediately when Auto is switched off during the fallback", () => {
    enableAuto();
    store.editVariable("value", "42");
    edited(edits()[0]);
    store.toggleAutoRefresh();
    expect(scans().length).toBe(2);
    snapshot(scans()[1], 42);
    window.advanceClock(VariablesStore.EDIT_REFRESH_FALLBACK_MS * 2);

    expect(scans().length).toBe(2);
    expect(store._editRefreshTimer).toBeNull();
    expect(source.idle.size).toBe(0);
  });

  it("preserves explicit Auto-off edit refreshes even after the panel hides", () => {
    store.editVariable("value", "42");
    store.setActive(false);
    edited(edits()[0]);

    expect(scans().length).toBe(1);
    expect(store._editRefreshTimer).toBeNull();
  });
});
