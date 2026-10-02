let main;
let outputRenderer;

function provider() {
  return {
    getActiveKernel: () => null,
    onDidChangeKernel: () => ({ dispose() {} }),
    onDidRemoveKernel: () => ({ dispose() {} }),
  };
}

describe("variable service edge lifetime", () => {
  beforeEach(() => {
    main = require("../lib/main");
    outputRenderer = require("../lib/output-renderer");
    main.initialize();
  });
  afterEach(() => {
    main.deactivate();
    outputRenderer.set(null);
  });

  it("does not let a replaced provider's disposer clear the current provider", () => {
    const previous = main.consumeJupyterKernel(provider());
    const currentProvider = provider();
    const current = main.consumeJupyterKernel(currentProvider);
    previous.dispose();

    expect(main.getSession().provider).toBe(currentProvider);
    current.dispose();
  });

  it("safely disposes a provider edge after the package session has gone", () => {
    const edge = main.consumeJupyterKernel(provider());
    main.deactivate();

    expect(() => edge.dispose()).not.toThrow();
  });

  it("does not let old optional service edges remove their replacements", () => {
    const previousOutput = main.consumeJupyterOutput({});
    const currentOutput = {};
    const output = main.consumeJupyterOutput(currentOutput);
    const previousExplorer = main.consumeJupyterExplorer({});
    const currentExplorer = {};
    const explorer = main.consumeJupyterExplorer(currentExplorer);
    previousOutput.dispose();
    previousExplorer.dispose();

    expect(outputRenderer.get()).toBe(currentOutput);
    expect(main.getSession().explorer).toBe(currentExplorer);
    output.dispose();
    explorer.dispose();
  });
});
