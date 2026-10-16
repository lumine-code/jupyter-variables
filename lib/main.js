const { CompositeDisposable, Disposable } = require("lumine");
const VariablesSession = require("./variables-session");

const VARIABLES_URI = "lumine://jupyter-variables";

let subscriptions = null;
let lifecycleGeneration = 0;
let session = null;
let pane = null;
let kernelConnection = null;
let outputConnection = null;
let explorerConnection = null;

function initialPackageBatchPending() {
  const packages = lumine.packages;
  return Boolean(
    packages?.activatePromise ||
    (packages?.hasLoadedInitialPackages?.() && !packages?.hasActivatedInitialPackages?.()),
  );
}

// A deserializer runs while the workspace is being restored, before initial
// package activation. Build the session in the hook Lumine guarantees before
// both paths, and keep it when activate() follows.
function initialize() {
  session ??= new VariablesSession();
}

function activate() {
  initialize();
  subscriptions = new CompositeDisposable(
    session.onDidChangeCurrentKernel(() => lumine.commands.invalidateAvailability()),
    lumine.commands.add("lumine-workspace", {
      "jupyter-variables:toggle": () => lumine.workspace.toggle(VARIABLES_URI),
      "jupyter-variables:toggle-focus": () => toggleFocus(),
      "jupyter-variables:refresh": {
        description: "Read the kernel's variables again, now.",
        isAvailable: () =>
          Boolean(
            session?.kernel?.language?.toLowerCase() === "python" &&
            !session.kernel.destroyed &&
            !session.destroyed,
          ),
        didDispatch: () => session.storeFor()?.fetchVariables(),
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === VARIABLES_URI ? getPane() : undefined)),
    new Disposable(() => destroyPane()),
    new Disposable(() => {
      session?.destroy();
      session = null;
    }),
  );
}

// Reveal and focus the pane, or hand focus back to the centre when it already
// has it. This is what the keystroke binds rather than `toggle`: pressing it a
// second time should return you to your work, not hide a pane you are looking
// at. jupyter-monitor and jupyter-inspector use the same shape.
async function toggleFocus() {
  const generation = lifecycleGeneration;
  const element = lumine.workspace.paneForURI(VARIABLES_URI)?.element;
  const isFocused =
    element &&
    (element.offsetWidth !== 0 || element.offsetHeight !== 0) &&
    element.contains(document.activeElement);

  if (isFocused) {
    lumine.workspace.getCenter().activate();
    return;
  }

  const item = await lumine.workspace.open(VARIABLES_URI, { searchAllPanes: true });
  if (generation !== lifecycleGeneration) return;
  item?.focus?.();
}

function deactivate() {
  lifecycleGeneration++;
  subscriptions?.dispose();
  subscriptions = null;
  // Also cover a pane made by the startup deserializer if activation never
  // completed (for example, a window closing during startup).
  destroyPane();
  session?.destroy();
  session = null;
  kernelConnection = null;
  outputConnection = null;
  explorerConnection = null;
  require("./output-renderer").set(null);
}

function consumeJupyterKernel(provider) {
  initialize();
  const targetSession = session;
  const connection = (kernelConnection = {});
  let disposed = false;
  const connect = () => {
    if (!disposed && kernelConnection === connection && session === targetSession) {
      targetSession.setProvider(provider);
    }
  };
  if (initialPackageBatchPending()) queueMicrotask(connect);
  else connect();
  return new Disposable(() => {
    disposed = true;
    // Every method on a wrapper throws once its kernel is gone, and without a
    // provider there is no kernel to name a namespace: the panel has nothing
    // left to show.
    if (kernelConnection === connection && session === targetSession) {
      kernelConnection = null;
      targetSession.setProvider(null);
      if (session === targetSession) destroyPane();
    }
  });
}

/**
 * jupyter-repl's renderers, for coloured and sanitized values. Optional: the
 * table falls back to plain text without them.
 */
function consumeJupyterOutput(service) {
  const outputRenderer = require("./output-renderer");
  const connection = (outputConnection = {});
  outputRenderer.set(service);
  return new Disposable(() => {
    if (outputConnection !== connection) return;
    outputConnection = null;
    outputRenderer.set(null);
  });
}

/**
 * jupyter-explorer, so a name in the table can be opened in a grid. Optional:
 * without it the panel simply offers no jump.
 */
function consumeJupyterExplorer(service) {
  initialize();
  const targetSession = session;
  const connection = (explorerConnection = {});
  targetSession.setExplorer(service);
  return new Disposable(() => {
    if (explorerConnection !== connection || session !== targetSession) return;
    explorerConnection = null;
    targetSession.setExplorer(null);
  });
}

function adoptPane(item) {
  pane = item;
  item.onDidDestroy(() => {
    if (pane === item) {
      pane = null;
    }
  });
  return item;
}

function getPane() {
  initialize();
  if (pane && !pane.destroyed) {
    return pane;
  }

  const existing = lumine.workspace
    .getPaneItems()
    .find((item) => item.getURI?.() === VARIABLES_URI);
  if (existing) return adoptPane(existing);
  require("@lumine-code/etch").setScheduler(lumine.views);
  const VariablesPane = require("./variables-pane");
  return adoptPane(new VariablesPane(session));
}

function destroyPane() {
  const items = lumine.workspace.getPaneItems().filter((item) => item.getURI?.() === VARIABLES_URI);
  if (pane && !items.includes(pane)) {
    items.push(pane);
  }
  for (const item of items) {
    item.destroy();
  }
  pane = null;
}

function deserializeVariablesPane() {
  return getPane();
}

module.exports = {
  provideMcpTools() {
    return require("./mcp-tools").createTools(() => session);
  },
  provideBackgroundTips() {
    return {
      packageName: "jupyter-variables",
      tips: [
        "You can browse everything the kernel has in memory with {{ 'jupyter-variables:toggle-focus' | keystroke }}",
      ],
    };
  },

  initialize,
  activate,
  deactivate,
  deserializeVariablesPane,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeJupyterExplorer,
  VARIABLES_URI,
  // The specs drive the session directly; nothing else should reach for it.
  getSession: () => session,
};
