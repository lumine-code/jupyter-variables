const { CompositeDisposable, Disposable } = require("atom");
const VariablesSession = require("./variables-session");

const VARIABLES_URI = "lumine://jupyter-variables";

let subscriptions = null;
let session = null;

function activate() {
  session = new VariablesSession();
  subscriptions = new CompositeDisposable(
    atom.commands.add("atom-workspace", {
      "jupyter-variables:toggle": () => atom.workspace.toggle(VARIABLES_URI),
      "jupyter-variables:refresh": () => session.storeFor()?.fetchVariables(),
    }),
    atom.workspace.addOpener((uri) => (uri === VARIABLES_URI ? createPane() : undefined)),
    new Disposable(() => destroyPane()),
    new Disposable(() => session.destroy()),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  session = null;
}

function consumeJupyterKernel(provider) {
  session.setProvider(provider);
  return new Disposable(() => {
    // Every method on a wrapper throws once its kernel is gone, and without a
    // provider there is no kernel to name a namespace: the panel has nothing
    // left to show.
    session.setProvider(null);
    destroyPane();
  });
}

/**
 * jupyter-repl's renderers, for coloured and sanitized values. Optional: the
 * table falls back to plain text without them.
 */
function consumeJupyterOutput(service) {
  const outputRenderer = require("./output-renderer");
  outputRenderer.set(service);
  return new Disposable(() => outputRenderer.set(null));
}

/**
 * jupyter-explorer, so a name in the table can be opened in a grid. Optional:
 * without it the panel simply offers no jump.
 */
function consumeJupyterExplorer(service) {
  session.setExplorer(service);
  return new Disposable(() => session.setExplorer(null));
}

function createPane() {
  const VariablesPane = require("./variables-pane");
  return new VariablesPane(session);
}

function destroyPane() {
  atom.workspace
    .getPaneItems()
    .find((item) => item.getURI?.() === VARIABLES_URI)
    ?.destroy();
}

module.exports = {
  activate,
  deactivate,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeJupyterExplorer,
  VARIABLES_URI,
  // The specs drive the session directly; nothing else should reach for it.
  getSession: () => session,
};
