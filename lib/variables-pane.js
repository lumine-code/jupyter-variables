const { CompositeDisposable, Disposable, Emitter } = require("lumine");
const Variables = require("./variables");

const VARIABLES_URI = "lumine://jupyter-variables";

class VariablesPane {
  constructor(session) {
    this.emitter = new Emitter();
    this.session = session;
    this.destroyed = false;
    this.element = document.createElement("div");
    this.element.classList.add("jupyter-variables");
    this.element.tabIndex = -1;

    this.component = new Variables({ store: session });
    this.element.appendChild(this.component.element);

    // While this pane exists the stores follow their kernels' idles; closing
    // it pauses auto-refresh rather than leaving the namespace dump running
    // after every cell with nothing on screen to show for it.
    this.session.setViewActive(true);

    this.disposer = new CompositeDisposable(new Disposable(() => this.component.destroy()));
  }

  getTitle = () => "Variables";
  getIconName = () => "database";
  getURI = () => VARIABLES_URI;
  getDefaultLocation = () => "right";
  getAllowedLocations = () => ["left", "right", "bottom"];

  focus = () => {
    const filter = this.element.querySelector("lumine-text-editor");
    (filter || this.element).focus?.({ preventScroll: true });
  };

  /**
   * A pane only drops an item it is told about. Destroying the item directly —
   * which is what happens when the kernel service goes away — leaves the tab
   * behind without this.
   *
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.session.setViewActive(false);
    this.disposer.dispose();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

module.exports = VariablesPane;
module.exports.VARIABLES_URI = VARIABLES_URI;
