const { TextBuffer } = require("lumine");
const etch = require("@lumine-code/etch");
function hugeSource() {
  let source = TextBuffer.createTextSnapshot("x".repeat(65536));
  while (source.length < 1024 * 1024 * 1024)
    source = source.replace(source.length, source.length, source);
  return source;
}
const Variables = require("../lib/variables");
const VariablesSession = require("../lib/variables-session");
function kernel() {
  return {
    language: "python",
    destroyed: false,
    onDidChangeGeneration: () => ({ dispose() {} }),
    onDidBecomeIdle: () => ({ dispose() {} }),
  };
}
describe("variables filter input budget", () => {
  it("keeps the standalone namespace model usable without text editor services", () => {
    const script = `
const assert = require("node:assert/strict");
const Module = require("node:module");
const api = Module.createRequire(${JSON.stringify(require.resolve("lumine"))})("@lumine-code/event-kit");
const load = Module._load;
Module._load = function(name, ...args) { return name === "lumine" ? api : load.call(this, name, ...args); };
global.lumine = {config:{get:()=>false}};
const {VariablesStore} = require(${JSON.stringify(require.resolve("../lib/variables-store"))});
const store = new VariablesStore({onDidChangeGeneration:()=>new api.Disposable()},false);
assert.equal(store.setFilterText("fram"),true);
assert.equal(store.filterText,"fram");
assert.equal(store.setFilterText("x".repeat(4097)),false);
assert.equal(store.filterText,"fram");
assert.equal(store.filterSource.length,4097);
store.destroy();
`;
    const result = require("node:child_process").spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    expect(result.status)
      .withContext(result.stderr || result.error?.message)
      .toBe(0);
  });
  let session, view;
  beforeEach(() => {
    session = new VariablesSession();
    session.setKernel(kernel());
    view = new Variables({ store: session });
  });
  afterEach(() => {
    view?.destroy();
    session.destroy();
  });
  it("retains a huge invalid filter per kernel and recovers after shortening", () => {
    const owner = session.kernel;
    const store = session.storeFor();
    store.setFilterText("old");
    etch.updateSync(view);
    const editor = view.refs.filter.editor;
    const read = spyOn(editor, "getText").and.throwError("whole filter read");
    editor.setText(hugeSource());
    etch.updateSync(view);
    lumine.commands.dispatch(editor.element, "core:confirm");
    expect(store.filterText).toBe("old");
    expect(store.filterError).toContain("4,096");
    expect(read).not.toHaveBeenCalled();
    read.and.callThrough();
    session.setKernel(kernel());
    etch.updateSync(view);
    expect(view.refs.filter.editor.getBuffer().getLength()).toBe(0);
    session.setKernel(owner);
    etch.updateSync(view);
    expect(view.refs.filter.editor.getBuffer().getLength()).toBe(1024 * 1024 * 1024);
    view.refs.filter.editor.setText("new");
    etch.updateSync(view);
    expect(store.filterText).toBe("new");
    expect(store.filterError).toBeNull();
    expect(view.element.querySelector(".input-budget-error").hidden).toBeTrue();
  });
  it("accepts the complete boundary query and never applies an over-budget prefix", () => {
    const store = session.storeFor();
    expect(store.setFilterText("a".repeat(4096))).toBeTrue();
    expect(store.setFilterText("b".repeat(4097))).toBeFalse();
    expect(store.filterText).toBe("a".repeat(4096));
  });
});
