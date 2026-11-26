const InputBudget = require("./input-budget");
const { Emitter } = require("lumine");

// Every scan uses bounded summaries. Rich display hooks run only for the
// explicitly requested preview, in the same isolated namespace.
const SNAPSHOT_HELPER_CODE = `
def _get_variables():
    import json
    import sys
    import types

    def loaded_type(module_name, name):
        module = sys.modules.get(module_name)
        return vars(module).get(name) if module is not None else None

    ndarray = loaded_type('numpy', 'ndarray')
    dataframe = loaded_type('pandas', 'DataFrame')
    series = loaded_type('pandas', 'Series')
    collections = (list, tuple, dict, set, frozenset, range)
    skip_names = {'get_ipython', 'exit', 'quit', 'In', 'Out'}
    # Include the JSON envelope and the final line break in the byte budget.
    rows, units, truncated = [], 40, False

    def entries():
        nonlocal truncated
        try:
            yield from _user_ns.items()
        except RuntimeError:
            # A background Python thread changed the namespace during the scan.
            truncated = True

    type_name = type.__dict__['__name__'].__get__
    for name, value in entries():
        if type(name) is not str or name.startswith('_') or name in skip_names:
            continue
        if len(name) > 1024:
            truncated = True
            continue
        if _name_contains and _name_contains not in name.lower():
            continue
        kind = type(value)
        if issubclass(kind, types.ModuleType):
            continue
        if len(rows) >= 1000:
            truncated = True
            break
        label = type_name(kind)[:160]
        previewable = False
        if kind is str or kind is bytes or kind is bytearray:
            length = len(value)
            text = repr(value) if length <= 160 else f'{label}(length={length:,}) {repr(value[:160])}…'
            previewable = 160 < length <= 1000
        elif kind is int:
            bits = value.bit_length()
            text = repr(value) if bits <= 512 else f'int(bits={bits:,})'
        elif kind is bool or kind is float or kind is complex or value is None:
            text = repr(value)
        else:
            text = f'<{label}>'
            previewable = True
            try:
                if kind is ndarray:
                    text = f'array(shape={value.shape}, dtype={value.dtype.name})'
                elif kind is dataframe:
                    height, width = value.shape
                    text = f'DataFrame({height:,} rows × {width:,} cols)'
                elif kind is series:
                    text = f'Series(length={len(value):,})'
                elif any(kind is collection for collection in collections):
                    text = f'{label}(length={len(value):,})'
            except Exception:
                pass
        row = json.dumps({'name': name, 'type': label, 'repr': {'text': text[:500]}, 'previewable': previewable}, separators=(',', ':'))
        units += len(row) + 1
        if units > 256 * 1024:
            truncated = True
            break
        rows.append(row)
    print('{"variables":[' + ','.join(rows) + '],"truncated":' + json.dumps(truncated) + '}')

_get_variables()
`;

const PREVIEW_HELPER_CODE = `
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
    MAX_REPR_CHARS = 10000        # bound custom HTML, markdown and pretty text

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
    for name, value in list(_user_ns.items()):
        if name.startswith('_') or name in SKIP_NAMES:
            continue
        if isinstance(value, types.ModuleType):
            continue
        try:
            var_type = type(value).__name__
            mro = _mro_names(value)
            repr_data = {}

            if 'ndarray' in mro:
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
                        if isinstance(markdown, str) and markdown and len(markdown) <= MAX_REPR_CHARS:
                            repr_data['markdown'] = markdown
                    except Exception:
                        pass

                if hasattr(value, '_repr_html_'):
                    try:
                        html = value._repr_html_()
                        if isinstance(html, str) and html and len(html) <= MAX_REPR_CHARS:
                            repr_data['html'] = html
                    except Exception:
                        pass

                if hasattr(value, '_repr_pretty_'):
                    # The protocol wants a RepresentationPrinter, not a plain
                    # stream; IPython's own pretty() drives it correctly.
                    try:
                        from IPython.lib.pretty import pretty
                        text = pretty(value)
                        repr_data['pretty'] = text[:MAX_REPR_CHARS] + ('...' if len(text) > MAX_REPR_CHARS else '')
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

function isolatedQuery(code, vars = '"_user_ns": globals()') {
  return `
(__builtins__ if __builtins__.__class__.__name__ == "dict" else __builtins__.__dict__)["exec"](
    ${JSON.stringify(code)},
    {"__builtins__": __builtins__, ${vars}}
)
`;
}

function namespaceCode(filter = "") {
  return isolatedQuery(
    SNAPSHOT_HELPER_CODE,
    `"_user_ns": globals(), "_name_contains": ${JSON.stringify(filter.toLowerCase())}`,
  );
}

const VARIABLES_CODE = namespaceCode();

function previewCode(name) {
  const nameLiteral = JSON.stringify(name);
  return isolatedQuery(
    PREVIEW_HELPER_CODE,
    `"_user_ns": {${nameLiteral}: globals()[${nameLiteral}]}`,
  );
}

function parseQueryOutput(result) {
  const stdout = result.outputs
    .filter((output) => output.output_type === "stream" && output.name === "stdout")
    .map((output) => (Array.isArray(output.text) ? output.text.join("") : output.text || ""))
    .join("")
    .trim();
  return JSON.parse(stdout.slice(stdout.lastIndexOf("\n") + 1));
}

function readSnapshot(result) {
  const snapshot = parseQueryOutput(result);
  const variables = Array.isArray(snapshot) ? snapshot : snapshot?.variables;
  if (!Array.isArray(variables) || !variables.every((row) => typeof row?.name === "string"))
    throw new Error("Malformed namespace data");
  return { variables, truncated: snapshot.truncated === true };
}

/**
 * One kernel's user namespace. There is one of these per kernel, made the first
 * time the panel is asked about that kernel and dropped when the kernel goes.
 */
class VariablesStore {
  static EDIT_REFRESH_FALLBACK_MS = 300;
  variables = [];
  namespaceTruncated = false;
  preview = null;
  filterText = "";

  constructor(kernel, active = true) {
    this.emitter = new Emitter();
    this.filterSource = InputBudget.source();
    this.kernel = kernel;
    this.autoRefresh = Boolean(lumine.config.get("jupyter-variables.autoRefresh"));
    this.idleSubscription = null;
    this._active = Boolean(active);
    this._fetching = false;
    this._fetchGeneration = 0;
    this._refreshRevision = 0;
    this._successfulRefreshRevision = 0;
    this._refreshEpoch = 0;
    this._refreshPending = false;
    this._editRefreshTimer = null;
    this.destroyed = false;
    this._editRequests = new Set();
    this.generationSubscription = kernel.onDidChangeGeneration(() => {
      this._refreshEpoch++;
      this._fetchGeneration++;
      this._fetchRequest?.dispose();
      this._fetchRequest = null;
      this._clearPreview();
      this._clearNamespaceFilter();
      for (const request of this._editRequests) request.dispose();
      this._editRequests.clear();
      this._fetching = false;
      this._refreshPending = false;
      this._cancelEditRefresh();
      this.variables = [];
      this.namespaceTruncated = false;
      this.cachedAt = null;
      this.lastRefreshError = "The kernel session changed. Refresh its namespace.";
      this.emitter.emit("did-update");
    });
    this.cachedAt = null;
    this.cachedExecutionCount = null;
    this.cachedExecutionTime = null;
    this.lastRefreshError = null;
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

  get refreshing() {
    return this._fetching || this._refreshPending || this._editRefreshTimer !== null;
  }

  get filteredVariables() {
    if (!this.filterText) {
      return this.variables;
    }
    if (this.filteredSnapshot) return this.filteredSnapshot.variables;
    const filter = this.filterText.toLowerCase();
    return this.variables.filter((variable) => variable.name.toLowerCase().includes(filter));
  }

  setFilterText = (text) => {
    this.filterSource = InputBudget.source(text);
    this.filterError = InputBudget.message(this.filterSource.length, 4096, "Filter");
    if (!this.filterError) {
      const next = this.filterSource.toString();
      if (this.filterText !== next) {
        this.filterText = next;
        this._clearPreview();
        this._scheduleNamespaceFilter();
      }
    }
    this.emitter.emit("did-update");
    return !this.filterError;
  };

  get filtering() {
    return Boolean(this._namespaceFilter);
  }

  _clearNamespaceFilter() {
    const pending = this._namespaceFilter;
    this._namespaceFilter = null;
    clearTimeout(pending?.timer);
    pending?.request?.dispose();
    this.filteredSnapshot = null;
    this.namespaceFilterError = null;
  }

  _scheduleNamespaceFilter() {
    this._clearNamespaceFilter();
    if (!this.namespaceTruncated || !this.filterText || !this._active || !this.isPython) return;
    const pending = { timer: null, request: null };
    this._namespaceFilter = pending;
    pending.timer = setTimeout(async () => {
      try {
        pending.request = this.kernel.request({
          type: "execute",
          purpose: "query",
          priority: "background",
          code: namespaceCode(this.filterText),
        });
        const result = await pending.request.done;
        if (this._namespaceFilter !== pending) return;
        if (result.status !== "ok")
          throw new Error(result.error?.evalue || `Namespace filter ${result.status}.`);
        this.filteredSnapshot = readSnapshot(result);
      } catch (error) {
        if (this._namespaceFilter === pending)
          this.namespaceFilterError = String(error.message || error).slice(0, 1000);
      } finally {
        pending.request?.dispose();
        if (this._namespaceFilter === pending) {
          this._namespaceFilter = null;
          this.emitter.emit("did-update");
        }
      }
    }, 150);
  }

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
    if (!active) {
      this._refreshEpoch++;
      this._cancelEditRefresh();
      this._refreshPending = false;
      this._fetchGeneration++;
      this._fetching = false;
      this._fetchRequest?.dispose();
      this._fetchRequest = null;
      this._clearPreview();
      this._clearNamespaceFilter();
    }
    this._syncIdleSubscription();
    if (active && this.autoRefresh) {
      this.fetchVariables();
    } else if (active) {
      this._scheduleNamespaceFilter();
    }
  }

  toggleAutoRefresh = () => {
    const editRefreshPending = this._editRefreshTimer !== null;
    this.autoRefresh = !this.autoRefresh;
    if (!this.autoRefresh) this._cancelEditRefresh();
    this.emitter.emit("did-update");
    this._syncIdleSubscription();
    if (this._active && (this.autoRefresh || editRefreshPending)) {
      this.fetchVariables();
    }
  };

  // A kernel falling idle is the only moment the namespace can have changed
  // without this panel having asked for it — but only a visible panel needs
  // to know, and a destroyed wrapper has nothing left to subscribe to.
  _syncIdleSubscription() {
    const wanted = this._active && this.autoRefresh && this.kernel && !this.kernel.destroyed;
    if (wanted && !this.idleSubscription) {
      this.idleSubscription = this.kernel.onDidBecomeIdle(() =>
        this.fetchVariables({ background: true }),
      );
    } else if (!wanted && this.idleSubscription) {
      this.idleSubscription.dispose();
      this.idleSubscription = null;
    }
  }

  fetchVariables = ({ background = false } = {}) => {
    this._cancelEditRefresh();
    if (this.destroyed || !this.kernel || this.kernel.destroyed) {
      this._refreshPending = false;
      return;
    }
    if (!this.isPython) {
      this._refreshPending = false;
      this.setVariables([]);
      return;
    }
    const revision = ++this._refreshRevision;
    if (this._fetching) {
      this._refreshPendingBackground =
        background && (!this._refreshPending || this._refreshPendingBackground);
      this._refreshPending = true;
      return;
    }
    this._refreshPending = false;
    this._refreshPendingBackground = false;
    this._fetching = true;
    const generation = ++this._fetchGeneration;
    const kernel = this.kernel;
    const kernelGeneration = kernel.generation;
    const current = () =>
      !this.destroyed &&
      generation === this._fetchGeneration &&
      this.kernel === kernel &&
      kernel.generation === kernelGeneration;
    const finish = () => {
      if (!current()) return;
      this._fetching = false;
      this._fetchRequest = null;
      this.emitter.emit("did-update");
      if (this._refreshPending)
        queueMicrotask(() => {
          if (current() && this._refreshPending)
            this.fetchVariables({ background: this._refreshPendingBackground });
        });
    };
    let request;
    try {
      request = this._fetchRequest = kernel.request({
        type: "execute",
        purpose: "query",
        ...(background ? { priority: "background" } : {}),
        code: VARIABLES_CODE,
        timeoutMs: 10000,
      });
    } catch (error) {
      this.lastRefreshError = String(error.message || error).slice(0, 1000);
      finish();
      return;
    }
    void request.done
      .then(
        (result) => {
          if (!current()) return;
          if (result.status !== "ok") {
            this.lastRefreshError = String(
              result.error?.evalue || `Namespace refresh ${result.status}.`,
            ).slice(0, 1000);
          } else {
            try {
              const { variables, truncated } = readSnapshot(result);
              this._successfulRefreshRevision = revision;
              this.setVariables(variables, truncated);
            } catch {
              this.lastRefreshError = "The namespace refresh returned malformed data.";
            }
          }
          finish();
        },
        (error) => {
          if (!current()) return;
          this.lastRefreshError = String(error.message || error).slice(0, 1000);
          finish();
        },
      )
      .finally(() => request.dispose());
  };

  _cancelEditRefresh() {
    if (this._editRefreshTimer !== null) clearTimeout(this._editRefreshTimer);
    this._editRefreshTimer = null;
  }

  _refreshAfterEdit(coverage) {
    // Idle may precede a delayed shell reply. An Auto/manual scan requested
    // after that exact idle already covers this edit; do not schedule a second
    // one when its reply finally arrives. This does not suppress any idle.
    if (
      coverage?.epoch === this._refreshEpoch &&
      this._refreshRevision > coverage.revision &&
      (this._fetching ||
        this._refreshPending ||
        (this._successfulRefreshRevision > coverage.revision && !this.lastRefreshError))
    )
      return;
    this._cancelEditRefresh();
    if (!this.autoRefresh) {
      this.fetchVariables();
    } else if (this._active) {
      // The provider normally announces this edit through its coalesced idle
      // signal. Let that signal request the scan; keep a bounded fallback for
      // middleware or another watch suppressing the notification. Every idle
      // remains an invalidation, including foreign and silent executions.
      this._editRefreshTimer = setTimeout(() => {
        this._editRefreshTimer = null;
        if (!this.destroyed && this._active && this.autoRefresh)
          this.fetchVariables({ background: true });
      }, VariablesStore.EDIT_REFRESH_FALLBACK_MS);
    }
  }

  setVariables = (variables, truncated = false) => {
    this._clearPreview();
    this.variables = variables;
    this.namespaceTruncated = truncated;
    this._scheduleNamespaceFilter();
    this.cachedAt = new Date().toISOString();
    this.cachedExecutionCount = this.kernel?.executionCount ?? null;
    this.cachedExecutionTime = this.kernel?.lastExecutionTime ?? null;
    this.lastRefreshError = null;
    this.emitter.emit("did-update");
  };

  _clearPreview() {
    this._previewRequest?.dispose();
    this._previewRequest = null;
    this.preview = null;
  }

  previewVariable = async (name) => {
    const open = this.preview?.name !== name;
    this._clearPreview();
    if (!open || this.destroyed || !this.isPython) {
      if (!this.destroyed) this.emitter.emit("did-update");
      return;
    }
    const preview = (this.preview = { name, loading: true });
    this.emitter.emit("did-update");
    let request;
    try {
      request = this._previewRequest = this.kernel.request({
        type: "execute",
        purpose: "query",
        code: previewCode(name),
      });
      const result = await request.done;
      if (this.preview !== preview) return;
      if (result.status !== "ok")
        throw new Error(result.error?.evalue || `Preview ${result.status}.`);
      const [value] = parseQueryOutput(result);
      if (value?.name !== name || !value.repr) throw new Error("No preview was returned.");
      preview.repr = value.repr;
    } catch (error) {
      if (this.preview === preview) preview.error = String(error.message || error).slice(0, 1000);
    } finally {
      request?.dispose();
      if (this.preview === preview) {
        this._previewRequest = null;
        preview.loading = false;
        this.emitter.emit("did-update");
      }
    }
  };

  editVariable = (name, newValue) => {
    if (this.destroyed || !this.kernel || this.kernel.destroyed) {
      return;
    }
    if (!this.isPython) {
      lumine.notifications.addWarning("Variable editing only works with Python kernels", {
        dismissable: true,
      });
      return;
    }

    const kernel = this.kernel;
    const generation = kernel.generation;
    const coverage = { revision: this._refreshRevision, epoch: this._refreshEpoch };
    let request;
    try {
      request = kernel.request({
        type: "execute",
        purpose: "user",
        code: `globals()[${JSON.stringify(name)}] = ${newValue}`,
      });
      this._editRequests.add(request);
    } catch (error) {
      lumine.notifications.addError("Failed to set variable", {
        detail: error.message || String(error),
        dismissable: true,
      });
      return;
    }
    void request.done
      .then((result) => {
        if (this.destroyed || this.kernel !== kernel || generation !== kernel.generation) return;
        if (result.status === "ok") {
          this._refreshAfterEdit(coverage);
        } else if (result.status !== "cancelled") {
          const error = result.error;
          const traceback = error?.traceback;
          lumine.notifications.addError("Failed to set variable", {
            detail: traceback?.length
              ? traceback.join("\n")
              : error?.evalue || `Variable edit ${result.status}.`,
            detailCollapsed: (traceback?.length ?? 0) > 1,
            dismissable: true,
          });
        }
      })
      .finally(() => {
        this._editRequests.delete(request);
        request.dispose();
      });
  };

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._refreshEpoch++;
    this._cancelEditRefresh();
    this._refreshPending = false;
    this._fetchGeneration++;
    this._fetchRequest?.dispose();
    this._fetchRequest = null;
    this._clearPreview();
    this._clearNamespaceFilter();
    for (const request of this._editRequests) request.dispose();
    this._editRequests.clear();
    this.generationSubscription?.dispose();
    this.idleSubscription?.dispose();
    this.idleSubscription = null;
    this._fetching = false;
    this.kernel = null;
    this.emitter.dispose();
  }
}

module.exports = { VariablesStore, VARIABLES_CODE, previewCode };
