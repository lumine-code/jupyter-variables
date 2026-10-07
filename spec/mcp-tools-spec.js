const { recordRequest, settle } = require("./request-fixture");
const path = require("path");
const { Disposable } = require("lumine");
function kernel(id) {
  return {
    id,
    language: "python",
    displayName: "Python 3",
    destroyed: false,
    executionState: "idle",
    executionCount: 3,
    lastExecutionTime: "2026-10-02T10:00:00.000Z",
    request: jasmine.createSpy("request"),
    onDidBecomeIdle: jasmine.createSpy("idle subscription").and.callFake(() => new Disposable()),
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function provider(kernels) {
  const listeners = {
    changed: [],
    removed: [],
  };
  return {
    listeners,
    getActiveKernel: () => kernels[0],
    getRunningKernels: () => kernels,
    onDidChangeKernel(callback) {
      listeners.changed.push(callback);
      return new Disposable();
    },
    onDidRemoveKernel(callback) {
      listeners.removed.push(callback);
      return new Disposable();
    },
  };
}
describe("cached variable MCP tools", () => {
  let session;
  let kernels;
  let tools;
  let maxBytes;
  beforeEach(() => {
    const VariablesSession = require("../lib/variables-session");
    const { createTools, MAX_RESPONSE_BYTES } = require("../lib/mcp-tools");
    session = new VariablesSession();
    kernels = [kernel("first"), kernel("second")];
    session.setProvider(provider(kernels));
    tools = Object.fromEntries(createTools(() => session).map((tool) => [tool.name, tool]));
    maxBytes = MAX_RESPONSE_BYTES;
  });
  afterEach(() => session.destroy());
  it("requires an explicit kernel and never creates or refreshes an inactive store", async () => {
    expect(() => tools.ListJupyterVariables.execute({})).toThrowError(/kernelId/);
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "second",
      }).status,
    ).toBe("cache-unavailable");
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "missing",
      }).status,
    ).toBe("kernel-not-found");
    expect(session.stores.size).toBe(0);
    expect(kernels[1].request).not.toHaveBeenCalled();
    expect(kernels[1].onDidBecomeIdle).not.toHaveBeenCalled();
    expect(tools.ListJupyterVariables.annotations.readOnlyHint).toBe(true);
  });
  it("reads the requested kernel, ignores the panel filter and detaches its snapshot", async () => {
    session.storeFor(kernels[0]).setVariables([
      {
        name: "wrong",
        type: "int",
        repr: {
          text: "1",
        },
      },
    ]);
    await settle();
    const store = session.storeFor(kernels[1]);
    store.setVariables([
      {
        name: "frame",
        type: "DataFrame",
        repr: {
          text: "(3, 2)",
          html: "<table></table>",
          png: "large-image",
        },
      },
    ]);
    await settle();
    store.setFilterText("does-not-match");
    await settle();
    const result = tools.GetJupyterVariable.execute({
      kernelId: "second",
      name: "frame",
    });
    expect(result.status).toBe("available");
    expect(result.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.stale).toBe(false);
    expect(result.variable.repr.png).toBeUndefined();
    result.variable.repr.text = "changed";
    result.variable.availableRepresentations.push("bogus");
    await settle();
    expect(store.variables[0].repr.text).toBe("(3, 2)");
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "second",
      }).variables.length,
    ).toBe(1);
    expect(kernels[1].request).not.toHaveBeenCalled();
  });
  it("distinguishes a missing cache from a successfully cached empty namespace", async () => {
    const store = session.storeFor(kernels[0]);
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).status,
    ).toBe("cache-unavailable");
    store.setVariables([]);
    await settle();
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).status,
    ).toBe("available");
    expect(
      tools.GetJupyterVariable.execute({
        kernelId: "first",
        name: "absent",
      }).status,
    ).toBe("not-found");
  });
  it("reports non-Python kernels explicitly instead of claiming their empty panel cache is a namespace", async () => {
    kernels[0].language = "julia";
    session.storeFor(kernels[0]).setVariables([]);
    await settle();
    const result = tools.ListJupyterVariables.execute({
      kernelId: "first",
    });
    expect(result.status).toBe("unsupported-kernel");
    expect(result.reason).toContain("Python");
    expect(kernels[0].request).not.toHaveBeenCalled();
  });
  it("marks known changes and failed refreshes stale and unknown baselines uncertain", async () => {
    const store = session.storeFor(kernels[0]);
    store.setVariables([
      {
        name: "value",
        type: "int",
        repr: {
          text: "3",
        },
      },
    ]);
    await settle();
    kernels[0].executionCount++;
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).stale,
    ).toBe(true);
    store.setVariables(store.variables);
    await settle();
    store.lastRefreshError = "kernel unavailable";
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).stale,
    ).toBe(true);
    store.lastRefreshError = null;
    kernels[0].executionCount = undefined;
    store.setVariables(store.variables);
    await settle();
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).stale,
    ).toBe(null);
  });
  it("reports a deferred edit refresh as stale without starting it from a cache read", async () => {
    session.setViewActive(true);
    await settle();
    const store = session.storeFor(kernels[0]);
    store.setVariables([
      {
        name: "value",
        type: "int",
        repr: {
          text: "3",
        },
      },
    ]);
    await settle();
    store.autoRefresh = true;
    kernels[0].request = jasmine.createSpy("request").and.callFake((specification) => {
      const handle = recordRequest(kernels[0], specification);
      handle.finish();
      return handle;
    });
    store.editVariable("value", "4");
    await settle();
    kernels[0].request.calls.reset();
    const result = tools.ListJupyterVariables.execute({
      kernelId: "first",
    });
    expect(result.stale).toBe(true);
    expect(result.refreshing).toBe(true);
    expect(result.variables[0].repr.text).toBe("3");
    expect(kernels[0].request).not.toHaveBeenCalled();
  });
  it("paginates and bounds encoded response bytes, including escaped and Unicode text", async () => {
    const store = session.storeFor(kernels[0]);
    store.setVariables(
      Array.from(
        {
          length: 200,
        },
        (_, index) => ({
          name: `v${index}`,
          type: "str",
          repr: {
            text: "\0🦉".repeat(8000),
            html: "x".repeat(8000),
          },
        }),
      ),
    );
    await settle();
    const result = tools.ListJupyterVariables.execute({
      kernelId: "first",
      limit: 200,
      maxChars: 8000,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(result.responseLimited).toBe(true);
    expect(result.nextOffset).toBe(result.variables.length);
    expect(result.variables[0].truncated).toBe(true);
    const next = tools.ListJupyterVariables.execute({
      kernelId: "first",
      offset: result.nextOffset,
      limit: 1,
    });
    expect(next.variables[0].name).toBe(`v${result.nextOffset}`);
    const single = tools.GetJupyterVariable.execute({
      kernelId: "first",
      name: "v0",
      maxChars: 8000,
    });
    expect(Buffer.byteLength(JSON.stringify(single), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(() =>
      tools.ListJupyterVariables.execute({
        kernelId: "first",
        limit: 100000,
      }),
    ).toThrowError(/limit/);
  });
  it("drops old caches on provider replacement and ignores disposed-provider events", async () => {
    const previous = session.provider;
    session.storeFor(kernels[0]).setVariables([]);
    await settle();
    const next = provider(kernels);
    session.setProvider(next);
    await settle();
    previous.listeners.changed[0](kernel("old"));
    await settle();
    previous.listeners.removed[0](kernels[0]);
    await settle();
    expect(session.kernel).toBe(kernels[0]);
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).status,
    ).toBe("cache-unavailable");
    session.setProvider(null);
    await settle();
    expect(
      tools.ListJupyterVariables.execute({
        kernelId: "first",
      }).status,
    ).toBe("provider-unavailable");
  });
});
describe("variable MCP service registration", () => {
  let pkg;
  let consumer;
  let kernelService;
  const registered = new Map();
  afterEach(async () => {
    if (pkg && lumine.packages.isPackageActive(pkg.name))
      await lumine.packages.deactivatePackage(pkg.name);
    consumer?.dispose();
    kernelService?.dispose();
    if (pkg && lumine.packages.isPackageLoaded(pkg.name))
      await lumine.packages.unloadPackage(pkg.name);
    pkg = consumer = kernelService = null;
    registered.clear();
  });
  it("publishes and unregisters tools with the package without evaluating inactive panels", async () => {
    consumer = lumine.packages.serviceHub.consume("mcp.tools", "^1.0.0", (tools) => {
      const own = tools.filter((tool) =>
        ["ListJupyterVariables", "GetJupyterVariable"].includes(tool.name),
      );
      for (const tool of own) registered.set(tool.name, tool);
      return new Disposable(() => {
        for (const tool of own) registered.delete(tool.name);
      });
    });
    const source = kernel("service-kernel");
    kernelService = lumine.packages.serviceHub.provide(
      "jupyter.kernel",
      "1.0.0",
      provider([source]),
    );
    pkg = lumine.packages.loadPackage(path.resolve(__dirname, ".."));
    await lumine.packages.activatePackage(pkg.name);
    await Promise.resolve();
    const main = pkg.mainModule;
    const tool = registered.get("ListJupyterVariables");
    expect(tool).toBeDefined();
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("cache-unavailable");
    expect(main.getSession().stores.size).toBe(0);
    expect(source.request).not.toHaveBeenCalled();
    kernelService.dispose();
    await settle();
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("provider-unavailable");
    await lumine.packages.deactivatePackage(pkg.name);
    expect(registered.size).toBe(0);
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("provider-unavailable");
    await lumine.packages.activatePackage(pkg.name);
    expect(registered.size).toBe(2);
  });
  it("does not let an older edge for the same provider object clear a new connection", async () => {
    const main = require("../lib/main");
    main.initialize();
    await settle();
    const source = provider([kernel("same")]);
    const old = main.consumeJupyterKernel(source);
    const current = main.consumeJupyterKernel(source);
    old.dispose();
    await settle();
    expect(main.getSession().provider).toBe(source);
    current.dispose();
    await settle();
    expect(main.getSession().provider).toBe(null);
    main.deactivate();
    await settle();
  });
});
