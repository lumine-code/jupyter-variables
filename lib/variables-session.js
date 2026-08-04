const { Emitter } = require("atom");
const { VariablesStore } = require("./variables-store");

/**
 * What the panel sees: the active kernel, and one namespace store per kernel.
 *
 * The stores used to hang off `jupyter-repl`'s internal Kernel objects. This
 * package only ever holds the wrappers `jupyter.kernel` hands over, so it keeps
 * its own map and drops an entry when its kernel goes.
 */
class VariablesSession {
  constructor() {
    this.emitter = new Emitter();
    this.provider = null;
    this.dataExplorer = null;
    this.kernel = null;
    this.stores = new Map();
    this.subscriptions = [];
  }

  /**
   * Invoke the callback whenever the active kernel changes, including to null.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChangeCurrentKernel(callback) {
    return this.emitter.on("did-change-kernel", callback);
  }

  setProvider(provider) {
    this.provider = provider;
    this.subscriptions = provider
      ? [
          provider.onDidChangeKernel((kernel) => this.setKernel(kernel)),
          provider.onDidRemoveKernel((kernel) => this.forget(kernel)),
        ]
      : [];
    this.setKernel(provider ? provider.getActiveKernel() : null);
  }

  setDataExplorer(service) {
    this.dataExplorer = service;
  }

  /**
   * Show a name in the Data Explorer, if that package is installed.
   * @param {JupyterKernel} kernel
   * @param {String} name
   */
  explore = (kernel, name) => {
    this.dataExplorer?.explore(kernel, name);
  };

  setKernel(kernel) {
    if (kernel === this.kernel) {
      return;
    }
    this.kernel = kernel || null;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  /**
   * The namespace store for a kernel, made on first ask.
   * @param {JupyterKernel} [kernel] - Defaults to the active one
   * @returns {VariablesStore|null}
   */
  storeFor(kernel = this.kernel) {
    if (!kernel) {
      return null;
    }
    if (!this.stores.has(kernel)) {
      this.stores.set(kernel, new VariablesStore(kernel));
    }
    return this.stores.get(kernel);
  }

  forget(kernel) {
    this.stores.get(kernel)?.destroy();
    this.stores.delete(kernel);
    if (this.kernel === kernel) {
      this.setKernel(null);
    }
  }

  destroy() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions = [];
    for (const store of this.stores.values()) {
      store.destroy();
    }
    this.stores.clear();
    this.provider = null;
    this.dataExplorer = null;
    this.setKernel(null);
  }
}

module.exports = VariablesSession;
