const { Disposable } = require("lumine");
describe("variable refresh availability", () => {
  it("reads the existing session kernel without constructing its namespace store", async () => {
    const main = require("../lib/main");
    main.initialize();
    main.activate();
    const target = lumine.workspace.getElement();
    const available = () => lumine.commands.canDispatch(target, "jupyter-variables:refresh");
    let edge;
    try {
      expect(available()).toBe(false);
      const kernel = { language: "python", onDidBecomeIdle: () => new Disposable() };
      edge = main.consumeJupyterKernel({
        getActiveKernel: () => kernel,
        onDidChangeKernel: () => new Disposable(),
        onDidRemoveKernel: () => new Disposable(),
      });
      await Promise.resolve();
      expect(available()).toBe(true);
      kernel.language = "julia";
      expect(available()).toBe(false);
      edge.dispose();
      expect(available()).toBe(false);
    } finally {
      edge?.dispose();
      main.deactivate();
    }
  });
});
