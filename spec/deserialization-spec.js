const path = require("path");
const manifest = require("../package.json");
const main = require("../lib/main");
const VariablesSession = require("../lib/variables-session");
const VariablesPane = require("../lib/variables-pane");

const DESERIALIZER = "jupyter-variables/VariablesPane";

function fakeKernel() {
  return {
    displayName: "Python 3",
    language: "python",
    destroyed: false,
    executeWatch() {},
    onDidBecomeIdle: () => ({ dispose() {} }),
  };
}

function fakeProvider(kernel) {
  let disposedSubscriptions = 0;
  return {
    get disposedSubscriptions() {
      return disposedSubscriptions;
    },
    getActiveKernel: () => kernel,
    onDidChangeKernel: () => ({ dispose: () => disposedSubscriptions++ }),
    onDidRemoveKernel: () => ({ dispose: () => disposedSubscriptions++ }),
  };
}

// Workspace state is restored before initial package activation. The pane may
// therefore be built by its deserializer before commands, openers, and consumed
// services are registered.
describe("restoring the Variables pane", () => {
  let loadedPackage = null;

  afterEach(async () => {
    if (loadedPackage && lumine.packages.isPackageActive(loadedPackage.name)) {
      await lumine.packages.deactivatePackage(loadedPackage.name);
    } else {
      main.deactivate();
    }
    if (loadedPackage && lumine.packages.isPackageLoaded(loadedPackage.name)) {
      lumine.packages.unloadPackage(loadedPackage.name);
    }
    loadedPackage = null;
  });

  it("declares the deserializer method named by its serialized state", () => {
    expect(manifest.deserializers[DESERIALIZER]).toBe("deserializeVariablesPane");
    expect(typeof main.deserializeVariablesPane).toBe("function");
  });

  it("serializes only the pane's identity", () => {
    main.initialize();
    const item = main.deserializeVariablesPane();

    expect(item.serialize()).toEqual({ deserializer: DESERIALIZER });
  });

  it("round-trips through the manifest-registered proxy before activation", () => {
    const sourceSession = new VariablesSession();
    const source = new VariablesPane(sourceSession);
    const state = source.serialize();
    source.destroy();
    sourceSession.destroy();

    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    loadedPackage = lumine.packages.loadPackage(path.resolve(__dirname, ".."));

    const restored = lumine.deserializers.deserialize(state);

    expect(restored).toBeTruthy();
    expect(restored.serialize()).toEqual(state);
    expect(restored.session).toBe(main.getSession());
    expect(loadedPackage.mainInitialized).toBe(true);
    expect(loadedPackage.mainActivated).toBe(false);
  });

  it("keeps the restored pane and its session when activation follows", () => {
    main.initialize();
    const restored = main.deserializeVariablesPane();
    const initializedSession = main.getSession();

    main.activate();

    expect(main.getSession()).toBe(initializedSession);
    expect(restored.session).toBe(initializedSession);
    expect(main.deserializeVariablesPane()).toBe(restored);
  });

  it("wires a late kernel provider into the restored session and removes the tab on loss", async () => {
    main.initialize();
    const restored = main.deserializeVariablesPane();
    const initializedSession = main.getSession();
    main.activate();
    expect(await lumine.workspace.open(main.VARIABLES_URI, { searchAllPanes: true })).toBe(
      restored,
    );

    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    const service = main.consumeJupyterKernel(provider);

    expect(main.getSession()).toBe(initializedSession);
    expect(restored.session).toBe(initializedSession);
    expect(initializedSession.provider).toBe(provider);
    expect(initializedSession.kernel).toBe(kernel);

    service.dispose();

    expect(provider.disposedSubscriptions).toBe(2);
    expect(restored.destroyed).toBe(true);
    expect(lumine.workspace.getPaneItems()).not.toContain(restored);
  });

  it("creates a new singleton after the restored pane is closed", () => {
    main.initialize();
    const first = main.deserializeVariablesPane();

    first.destroy();

    expect(main.deserializeVariablesPane()).not.toBe(first);
  });

  it("destroys the restored component and session once on deactivation", () => {
    main.initialize();
    const item = main.deserializeVariablesPane();
    const session = main.getSession();
    spyOn(item.component, "destroy").and.callThrough();
    spyOn(session, "destroy").and.callThrough();
    main.activate();

    main.deactivate();

    expect(item.component.destroy).toHaveBeenCalledTimes(1);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });
});
