const { Emitter } = require("atom");

// Python that walks the user namespace and reports each name with its type and
// the cheapest representation it can produce. Deliberately not `_repr_` on
// anything large: those methods materialise the value, which hangs the kernel
// on a big frame for no benefit — a summary line is what the table shows there.
const VARIABLES_CODE = `

import json
from io import StringIO

def _get_variables():
    # Get all variables from user namespace
    user_vars = {}
    # Variables to skip
    skip_vars = {'get_ipython', 'exit', 'quit', 'open', 'sys', 'json', 'StringIO', 'In', 'Out'}

    for name, value in globals().items():
        # Skip private variables, modules, and system variables
        if name.startswith('_') or name in skip_vars:
            continue
        if hasattr(value, '__module__'):
            if value.__module__ == '__main__' or value.__module__ is None:
                pass  # Include user-defined classes
            elif callable(value) and not hasattr(value, '__dict__'):
                continue  # Skip built-in functions

        try:
            var_type = type(value).__name__

            # Try special repr methods first
            repr_data = {}

            # Check for IPython.display.Image
            if hasattr(value, '__module__') and value.__module__ == 'IPython.core.display' and type(value).__name__ == 'Image':
                try:
                    import base64
                    if hasattr(value, 'data') and value.data:
                        if getattr(value, 'format', '') == 'png':
                            repr_data['png'] = base64.b64encode(value.data).decode('ascii')
                        elif getattr(value, 'format', '') in ('jpeg', 'jpg'):
                            repr_data['jpeg'] = base64.b64encode(value.data).decode('ascii')
                except:
                    pass

            # Check for numpy arrays
            if var_type == 'ndarray':
                try:
                    import numpy as np
                    # For numpy arrays, show shape and dtype
                    repr_data['text'] = f"array(shape={value.shape}, dtype={value.dtype})"
                    # Also try to show small arrays
                    if value.size <= 100:
                        repr_data['pretty'] = repr(value)
                except:
                    pass

            # Size limits to prevent kernel hangs on large objects
            MAX_CELLS = 10000  # For DataFrames: rows * cols
            MAX_LENGTH = 1000  # For Series, lists, dicts

            def _is_large_object(val, vtype):
                try:
                    if vtype == 'DataFrame':
                        rows, cols = val.shape
                        return rows * cols > MAX_CELLS
                    elif vtype == 'Series':
                        return len(val) > MAX_LENGTH
                    elif vtype in ('list', 'tuple', 'set', 'frozenset', 'dict'):
                        return len(val) > MAX_LENGTH
                    return False
                except:
                    return True  # If we can't determine size, assume it's large

            # For large objects, show summary instead of calling expensive _repr_ methods
            if _is_large_object(value, var_type):
                if var_type == 'DataFrame':
                    rows, cols = value.shape
                    repr_data['text'] = f"DataFrame({rows:,} rows × {cols} cols)"
                elif var_type == 'Series':
                    repr_data['text'] = f"Series(length={len(value):,}, dtype={value.dtype})"
                elif var_type in ('list', 'tuple', 'set', 'frozenset'):
                    repr_data['text'] = f"{var_type}(length={len(value):,})"
                elif var_type == 'dict':
                    repr_data['text'] = f"dict(length={len(value):,})"
            else:
                # Small objects - safe to use _repr_ methods
                # Check for _repr_markdown_
                if hasattr(value, '_repr_markdown_'):
                    try:
                        repr_data['markdown'] = value._repr_markdown_()
                    except:
                        pass

                # Check for _repr_html_
                if hasattr(value, '_repr_html_'):
                    try:
                        repr_data['html'] = value._repr_html_()
                    except:
                        pass

                # Check for _repr_pretty_
                if hasattr(value, '_repr_pretty_'):
                    try:
                        from io import StringIO
                        sio = StringIO()
                        value._repr_pretty_(sio, False)
                        repr_data['pretty'] = sio.getvalue()
                    except:
                        pass

            # Check for _repr_png_
            if hasattr(value, '_repr_png_'):
                try:
                    import base64
                    png_data = value._repr_png_()
                    if isinstance(png_data, bytes):
                        repr_data['png'] = base64.b64encode(png_data).decode('ascii')
                except:
                    pass

            # Check for _repr_jpeg_ or _repr_jpg_
            if hasattr(value, '_repr_jpeg_'):
                try:
                    import base64
                    jpg_data = value._repr_jpeg_()
                    if isinstance(jpg_data, bytes):
                        repr_data['jpeg'] = base64.b64encode(jpg_data).decode('ascii')
                except:
                    pass
            elif hasattr(value, '_repr_jpg_'):
                try:
                    import base64
                    jpg_data = value._repr_jpg_()
                    if isinstance(jpg_data, bytes):
                        repr_data['jpeg'] = base64.b64encode(jpg_data).decode('ascii')
                except:
                    pass

            # Fallback to regular repr
            if not repr_data:
                repr_str = repr(value)
                # Limit length for very long reprs
                if len(repr_str) > 1000:
                    repr_str = repr_str[:1000] + '...'
                repr_data['text'] = repr_str

            user_vars[name] = {
                'name': name,
                'type': var_type,
                'repr': repr_data
            }
        except:
            # Skip variables that can't be repr'd
            pass

    return list(user_vars.values())

print(json.dumps(_get_variables()))
del _get_variables
`;

/**
 * One kernel's user namespace. There is one of these per kernel, made the first
 * time the panel is asked about that kernel and dropped when the kernel goes.
 */
class VariablesStore {
  variables = [];
  filterText = "";
  autoRefresh = false;

  constructor(kernel) {
    this.emitter = new Emitter();
    this.kernel = kernel;
    this.idleSubscription = null;
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
    return Boolean(this.kernel?.language && this.kernel.language.toLowerCase() === "python");
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

  toggleAutoRefresh = () => {
    this.autoRefresh = !this.autoRefresh;
    this.emitter.emit("did-update");

    if (this.autoRefresh) {
      // A kernel falling idle is the only moment the namespace can have changed
      // without this panel having asked for it.
      this.idleSubscription ??= this.kernel.onDidBecomeIdle(() => this.fetchVariables());
      this.fetchVariables();
    } else {
      this.idleSubscription?.dispose();
      this.idleSubscription = null;
    }
  };

  fetchVariables = () => {
    if (!this.kernel) {
      return;
    }
    if (!this.isPython) {
      this.setVariables([]);
      return;
    }

    this.kernel.executeWatch(VARIABLES_CODE, (result) => {
      if (result.output_type === "stream" && result.name === "stdout") {
        try {
          this.setVariables(JSON.parse(result.text));
        } catch {
          // Incomplete or malformed output; the next run replaces it.
        }
      }
    });
  };

  setVariables = (variables) => {
    this.variables = variables;
    this.emitter.emit("did-update");
  };

  editVariable = (name, newValue) => {
    if (!this.kernel) {
      return;
    }
    if (!this.isPython) {
      atom.notifications.addWarning("Variable editing only works with Python kernels", {
        dismissable: true,
      });
      return;
    }

    this.kernel.executeWithCallback(`${name} = ${newValue}`, (result) => {
      if (result.output_type === "error") {
        const traceback = result.traceback;
        atom.notifications.addError("Failed to set variable", {
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
    this.kernel = null;
  }
}

module.exports = { VariablesStore, VARIABLES_CODE };
