const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("atom");
const outputRenderer = require("./output-renderer");

/**
 * Sanitize HTML by removing script tags for security.
 * Note: The HTML comes from kernel output (_repr_html_), which is generally
 * trusted, but we still strip scripts to prevent XSS from untrusted data.
 */
function sanitizeHTML(html) {
  if (!html || typeof html !== "string") return "";
  // jupyter-repl's sanitizer also strips inline handlers; the local regex is
  // the without-the-hub fallback.
  const service = outputRenderer.get();
  if (service) {
    return service.sanitizeHtml(html);
  }
  return html.replace(/<script[\s\S]*?<\/script>/gi, "");
}

// Coloured spans through jupyter-repl's ANSI renderer; plain text without it.
function ansiNodes(text) {
  const service = outputRenderer.get();
  if (service) {
    return service.ansiNodes(text);
  }
  // Strip the colour escapes rather than show them. Built at runtime because
  // a control character in a regex literal is a lint error.
  const escapes = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  return String(text ?? "").replace(escapes, "");
}

const IMAGE_STYLE = { maxWidth: "200px", maxHeight: "100px" };

/** A variable's value, in whichever representation the kernel supplied. */
function renderRepr(repr) {
  if (!repr) return null;

  if (repr.markdown) {
    return <div className="repr-markdown">{repr.markdown}</div>;
  }
  if (repr.html) {
    return <div className="repr-html" innerHTML={sanitizeHTML(repr.html)} />;
  }
  if (repr.png) {
    return (
      <img
        src={`data:image/png;base64,${repr.png}`}
        alt="Variable representation"
        className="repr-image"
        style={IMAGE_STYLE}
      />
    );
  }
  if (repr.jpeg) {
    return (
      <img
        src={`data:image/jpeg;base64,${repr.jpeg}`}
        alt="Variable representation"
        className="repr-image"
        style={IMAGE_STYLE}
      />
    );
  }
  if (repr.pretty) {
    return ansiNodes(repr.pretty);
  }
  if (repr.text) {
    return ansiNodes(repr.text);
  }

  return null;
}

/** The filter field, a real mini editor so it behaves like every other one. */
class FilterEditor {
  constructor(props) {
    this.props = props;
    etch.initialize(this);

    this.editor = atom.workspace.buildTextEditor({
      mini: true,
      placeholderText: "Filter by name...",
    });
    // Register with the text editor registry so it gets scopes / services,
    // matching the way editors are built elsewhere.
    const registry = atom.textEditors.add(this.editor);
    if (this.props.value) {
      this.editor.setText(this.props.value);
    }
    this.element.appendChild(this.editor.element);

    this.disposables = new CompositeDisposable(
      registry,
      this.editor.onDidChange(() => this.props.onChange(this.editor.getText())),
      atom.commands.add(this.editor.element, {
        "core:confirm": () => this.props.onChange(this.editor.getText()),
        "core:cancel": () => {
          this.editor.setText("");
          this.props.onChange("");
        },
      }),
    );
  }

  render() {
    return <div className="filter-editor" />;
  }

  update(props) {
    this.props = props;
    if (this.editor && this.editor.getText() !== props.value) {
      this.editor.setText(props.value || "");
    }
    return etch.update(this);
  }

  destroy() {
    this.disposables.dispose();
    this.editor?.destroy();
    return etch.destroy(this);
  }
}

/** The current Python kernel's user namespace, as an editable table. */
class Variables {
  constructor({ store }) {
    this.store = store;
    // The name being edited, if any: only one cell is editable at a time.
    this.editingName = null;
    this.editValue = "";
    this.variablesSubscription = null;

    etch.initialize(this);

    this.disposables = new CompositeDisposable(
      this.store.onDidChangeCurrentKernel(() => this.watchCurrentKernel()),
    );

    this.watchCurrentKernel();
  }

  get variableStore() {
    return this.store.storeFor();
  }

  // Variables belong to a kernel, so the subscription moves with the store's.
  watchCurrentKernel() {
    this.variablesSubscription?.dispose();
    const variableStore = this.variableStore;
    this.variablesSubscription = variableStore
      ? variableStore.onDidUpdate(() => etch.update(this))
      : null;
    this.editingName = null;
    etch.update(this);
  }

  handleEdit = (name, newValue) => {
    this.variableStore?.editVariable(name, newValue);
  };

  handleFilterChange = (text) => {
    this.variableStore?.setFilterText(text);
  };

  handleRefresh = () => {
    // Force refresh bypassing visibility check
    this.variableStore?.fetchVariables();
  };

  handleToggleAutoRefresh = () => {
    this.variableStore?.toggleAutoRefresh();
  };

  // The Data Explorer is another package; hand it the name through the service
  // it provides. With that package absent there is simply nothing to jump to.
  handleExplore = (name) => {
    const kernel = this.store.kernel;
    if (kernel) {
      this.store.explore(kernel, name);
    }
  };

  startEditing(variable) {
    const repr = variable.repr || {};
    this.editValue = repr.text || repr.pretty || "";
    this.editingName = variable.name;
    etch.update(this);
  }

  stopEditing() {
    this.editingName = null;
    etch.update(this);
  }

  submitEdit() {
    if (this.editingName && this.editValue !== "") {
      this.handleEdit(this.editingName, this.editValue);
    }
    this.stopEditing();
  }

  renderValueCell(variable) {
    if (this.editingName === variable.name) {
      return (
        <input
          type="text"
          className="variable-editor"
          value={this.editValue}
          onInput={(event) => {
            this.editValue = event.target.value;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              this.submitEdit();
            } else if (event.key === "Escape") {
              this.stopEditing();
            }
          }}
          onBlur={() => this.submitEdit()}
        />
      );
    }

    return (
      <div
        className="variable-value editable"
        title="Double-click to edit"
        onDoubleClick={() => this.startEditing(variable)}
      >
        {renderRepr(variable.repr)}
      </div>
    );
  }

  renderMessage(lines) {
    return (
      <div className="sidebar variables-panel">
        <background-tips>
          <ul className="centered background-message">{lines}</ul>
        </background-tips>
      </div>
    );
  }

  render() {
    const kernel = this.store.kernel;

    if (!kernel) {
      return this.renderMessage([<li>No kernel running</li>]);
    }

    const isPythonKernel = kernel.language && kernel.language.toLowerCase() === "python";
    if (!isPythonKernel) {
      return this.renderMessage([
        <li>The Variables panel only works with Python kernels</li>,
        <li className="text-subtle">
          Current kernel: {kernel.displayName || kernel.language || "Unknown"}
        </li>,
      ]);
    }

    const variableStore = this.variableStore;
    const data = variableStore.filteredVariables;

    return (
      <div className="sidebar variables-panel">
        <div className="variables-controls">
          <div className="filter-container">
            <FilterEditor value={variableStore.filterText} onChange={this.handleFilterChange} />
          </div>
          <div className="btn-group">
            <label className="input-label">
              <input
                className="input-checkbox"
                type="checkbox"
                checked={variableStore.autoRefresh}
                onChange={this.handleToggleAutoRefresh}
              />
            </label>
            <button
              className="btn icon icon-repo-sync"
              onClick={this.handleRefresh}
              title="Refresh variables"
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="variable-wrapper">
          <table className="variable-table">
            <thead>
              <tr className="variable-header">
                <th>Name</th>
                <th>Type</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {data.map((variable) => (
                <tr key={variable.name} className="variable-row">
                  <td className="variable-name">
                    <a
                      className="variable-name-link"
                      onClick={() => this.handleExplore(variable.name)}
                      title="Open in Data Explorer"
                    >
                      {variable.name}
                    </a>
                  </td>
                  <td className="variable-type">{variable.type}</td>
                  <td className="variable-value-cell">{this.renderValueCell(variable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  update() {
    return etch.update(this);
  }

  destroy() {
    this.variablesSubscription?.dispose();
    this.disposables.dispose();
    return etch.destroy(this);
  }
}

module.exports = Variables;
