const { Emitter } = require("lumine");

// Python that walks the user namespace and reports each name with its type and
// the cheapest representation it can produce. Deliberately not `_repr_` on
// anything large: those methods materialise the value, which hangs the kernel
// on a big frame for no benefit — a summary line is what the table shows there.
// Everything, imports included, lives inside the function so the walk leaves
// the namespace it reads exactly as it found it.
const VARIABLES_CODE = `
def _get_variables():
    import base64
    import json
    import types

    # IPython's own injections; a user's own imports are their namespace.
    SKIP_NAMES = {'get_ipython', 'exit', 'quit', 'In', 'Out'}

    # Size limits that keep the walk from materialising large values.
    MAX_CELLS = 10000              # DataFrame: rows * cols
    MAX_LENGTH = 1000              # str/bytes and sized collections
    MAX_IMAGE_BYTES = 256 * 1024   # ship thumbnails, not figures

    def _mro_names(value):
        try:
            return {c.__name__ for c in type(value).__mro__}
        except Exception:
            return {type(value).__name__}

    def _is_large(value, mro):
        # Subclasses count too: a Counter is a dict, a GeoDataFrame is a
        # DataFrame. A value whose size cannot be read is treated as large.
        try:
            if 'DataFrame' in mro:
                rows, cols = value.shape
                return rows * cols > MAX_CELLS
            if 'Series' in mro:
                return len(value) > MAX_LENGTH
            if isinstance(value, (str, bytes, bytearray)):
                return len(value) > MAX_LENGTH
            if isinstance(value, (list, tuple, set, frozenset, dict)):
                return len(value) > MAX_LENGTH
            return False
        except Exception:
            return True

    def _summarize(value, var_type, mro):
        try:
            if 'DataFrame' in mro:
                rows, cols = value.shape
                return f"DataFrame({rows:,} rows × {cols} cols)"
            if 'Series' in mro:
                return f"Series(length={len(value):,}, dtype={value.dtype})"
            if isinstance(value, (str, bytes, bytearray)):
                return f"{var_type}(length={len(value):,}) {repr(value[:80])}..."
            return f"{var_type}(length={len(value):,})"
        except Exception:
            return f"{var_type}(unsized)"

    def _encode_image(data):
        if not isinstance(data, (bytes, bytearray)) or not data or len(data) > MAX_IMAGE_BYTES:
            return None
        return base64.b64encode(data).decode('ascii')

    variables = []
    for name, value in list(globals().items()):
        if name.startswith('_') or name in SKIP_NAMES:
            continue
        if isinstance(value, types.ModuleType):
            continue
        try:
            var_type = type(value).__name__
            mro = _mro_names(value)
            repr_data = {}

            if var_type == 'ndarray':
                # Shape and dtype without touching the data; small arrays get
                # their real repr, which numpy prints cheaply.
                try:
                    repr_data['text'] = f"array(shape={value.shape}, dtype={value.dtype})"
                    if value.size <= 100:
                        repr_data['pretty'] = repr(value)
                except Exception:
                    pass
            elif _is_large(value, mro):
                repr_data['text'] = _summarize(value, var_type, mro)
            else:
                # Small values: safe to ask for the rich representations.
                if type(value).__module__ == 'IPython.core.display' and var_type == 'Image':
                    try:
                        encoded = _encode_image(getattr(value, 'data', None))
                        image_format = getattr(value, 'format', '')
                        if encoded and image_format == 'png':
                            repr_data['png'] = encoded
                        elif encoded and image_format in ('jpeg', 'jpg'):
                            repr_data['jpeg'] = encoded
                    except Exception:
                        pass

                if hasattr(value, '_repr_markdown_'):
                    try:
                        markdown = value._repr_markdown_()
                        if isinstance(markdown, str) and markdown:
                            repr_data['markdown'] = markdown
                    except Exception:
                        pass

                if hasattr(value, '_repr_html_'):
                    try:
                        html = value._repr_html_()
                        if isinstance(html, str) and html:
                            repr_data['html'] = html
                    except Exception:
                        pass

                if hasattr(value, '_repr_pretty_'):
                    # The protocol wants a RepresentationPrinter, not a plain
                    # stream; IPython's own pretty() drives it correctly.
                    try:
                        from IPython.lib.pretty import pretty
                        repr_data['pretty'] = pretty(value)
                    except Exception:
                        pass

                if 'png' not in repr_data and hasattr(value, '_repr_png_'):
                    try:
                        encoded = _encode_image(value._repr_png_())
                        if encoded:
                            repr_data['png'] = encoded
                    except Exception:
                        pass

                if 'jpeg' not in repr_data:
                    for method in ('_repr_jpeg_', '_repr_jpg_'):
                        if hasattr(value, method):
                            try:
                                encoded = _encode_image(getattr(value, method)())
                                if encoded:
                                    repr_data['jpeg'] = encoded
                            except Exception:
                                pass
                            break

            if not repr_data:
                text = repr(value)
                if len(text) > 1000:
                    text = text[:1000] + '...'
                repr_data['text'] = text

            variables.append({'name': name, 'type': var_type, 'repr': repr_data})
        except Exception:
            pass  # a value whose type itself misbehaves is skipped

    return json.dumps(variables)

print(_get_variables())
del _get_variables
`;

/**
 * One kernel's user namespace. There is one of these per kernel, made the first
 * time the panel is asked about that kernel and dropped when the kernel goes.
 */
class VariablesStore {
  variables = [];
  filterText = "";

  constructor(kernel, active = true) {
    this.emitter = new Emitter();
    this.kernel = kernel;
    this.autoRefresh = Boolean(lumine.config.get("jupyter-variables.autoRefresh"));
    this.idleSubscription = null;
    this._active = Boolean(active);
    this._fetching = false;
    this._syncIdleSubscription();
    if (this._active && this.autoRefresh) {
      this.fetchVariables();
    }
  }

  /**
   * Invoke the callback whenever the variables, the filter, or the auto-refresh
   * flag change.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  get isPython() {
    const kernel = this.kernel;
    return Boolean(
      kernel && !kernel.destroyed && kernel.language && kernel.language.toLowerCase() === "python",
    );
  }

  get filteredVariables() {
    if (!this.filterText) {
      return this.variables;
    }
    const filter = this.filterText.toLowerCase();
    return this.variables.filter((variable) => variable.name.toLowerCase().includes(filter));
  }

  setFilterText = (text) => {
    this.filterText = text;
    this.emitter.emit("did-update");
  };

  /**
   * Whether a panel is on screen to read this store. While inactive the idle
   * subscription is dropped — the auto-refresh flag survives, so reopening the
   * panel resumes exactly where it left off, with one fresh fetch.
   * @param {Boolean} active
   */
  setActive(active) {
    active = Boolean(active);
    if (active === this._active) {
      return;
    }
    this._active = active;
    this._syncIdleSubscription();
    if (active && this.autoRefresh) {
      this.fetchVariables();
    }
  }

  toggleAutoRefresh = () => {
    this.autoRefresh = !this.autoRefresh;
    this.emitter.emit("did-update");
    this._syncIdleSubscription();
    if (this.autoRefresh && this._active) {
      this.fetchVariables();
    }
  };

  // A kernel falling idle is the only moment the namespace can have changed
  // without this panel having asked for it — but only a visible panel needs
  // to know, and a destroyed wrapper has nothing left to subscribe to.
  _syncIdleSubscription() {
    const wanted = this._active && this.autoRefresh && this.kernel && !this.kernel.destroyed;
    if (wanted && !this.idleSubscription) {
      this.idleSubscription = this.kernel.onDidBecomeIdle(() => this.fetchVariables());
    } else if (!wanted && this.idleSubscription) {
      this.idleSubscription.dispose();
      this.idleSubscription = null;
    }
  }

  fetchVariables = () => {
    if (!this.kernel || this.kernel.destroyed) {
      return;
    }
    if (!this.isPython) {
      this.setVariables([]);
      return;
    }
    // The idle signal is kernel-wide and a chatty client can fire it faster
    // than the namespace dump returns. One fetch at a time: a tick arriving
    // mid-fetch is dropped, and the next idle fetches again.
    if (this._fetching) {
      return;
    }

    this._fetching = true;
    // ipykernel flushes stdout in chunks, so a large namespace arrives as
    // several stream messages; buffer them and parse once, when the kernel
    // says it is done.
    let stdout = "";
    this.kernel.executeWatch(VARIABLES_CODE, (result) => {
      if (result.output_type === "stream" && result.name === "stdout") {
        stdout += result.text;
      } else if (result.output_type === "error") {
        // A failed dump — or a restart settling the watch — keeps the table.
        this._fetching = false;
      } else if (result.output_type === "status" && result.execution_state === "idle") {
        this._fetching = false;
        if (stdout) {
          try {
            this.setVariables(JSON.parse(stdout));
          } catch {
            // Incomplete or malformed output; the next run replaces it.
          }
        }
      }
    });
  };

  setVariables = (variables) => {
    this.variables = variables;
    this.emitter.emit("did-update");
  };

  editVariable = (name, newValue) => {
    if (!this.kernel || this.kernel.destroyed) {
      return;
    }
    if (!this.isPython) {
      lumine.notifications.addWarning("Variable editing only works with Python kernels", {
        dismissable: true,
      });
      return;
    }

    this.kernel.executeWithCallback(`${name} = ${newValue}`, (result) => {
      if (result.output_type === "error") {
        const traceback = result.traceback;
        lumine.notifications.addError("Failed to set variable", {
          description: Array.isArray(traceback)
            ? traceback.join("\n")
            : result.evalue || "Unknown error",
          dismissable: true,
        });
        return;
      }
      this.fetchVariables();
    });
  };

  destroy() {
    this.idleSubscription?.dispose();
    this.idleSubscription = null;
    this._fetching = false;
    this.kernel = null;
  }
}

module.exports = { VariablesStore, VARIABLES_CODE };
