const { CompositeDisposable, Disposable } = require("lumine");
const VariablesSession = require("./variables-session");
const VariablesPane = require("./variables-pane");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

const { VARIABLES_URI } = VariablesPane;

let subscriptions = null;
let session = null;

function activate() {
  session = new VariablesSession();
  subscriptions = new CompositeDisposable(
    lumine.commands.add("lumine-workspace", {
      "jupyter-variables:toggle": () => lumine.workspace.toggle(VARIABLES_URI),
      "jupyter-variables:toggle-focus": () => toggleFocus(),
      "jupyter-variables:refresh": {
        description: "Read the kernel's variables again, now.",
        didDispatch: () => session.storeFor()?.fetchVariables(),
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === VARIABLES_URI ? createPane() : undefined)),
    new Disposable(() => destroyPane()),
    new Disposable(() => session.destroy()),
  );
}

// Reveal and focus the pane, or hand focus back to the centre when it already
// has it. This is what the keystroke binds rather than `toggle`: pressing it a
// second time should return you to your work, not hide a pane you are looking
// at. jupyter-monitor and jupyter-inspector use the same shape.
async function toggleFocus() {
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
  item?.focus?.();
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
  return new VariablesPane(session);
}

function destroyPane() {
  lumine.workspace
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
