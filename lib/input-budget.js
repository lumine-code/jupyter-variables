module.exports = class InputBudget {
  static source(value = "") {
    if (value && typeof value.chunks === "function") return value;
    return require("lumine").TextBuffer.createTextSnapshot(String(value));
  }

  static message(length, limit, label) {
    return length > limit
      ? `${label} exceeds ${limit.toLocaleString("en-US")} UTF-16 units. Shorten it before applying.`
      : null;
  }

  constructor(editor, container, { limit, label }) {
    this.editor = editor;
    this.limit = limit;
    this.label = label;
    this.element = container.ownerDocument.createElement("div");
    this.element.className = "text-error input-budget-error";
    this.element.setAttribute("role", "status");
    container.appendChild(this.element);
    this.validate();
  }

  validate() {
    const message = InputBudget.message(
      this.editor.getBuffer().getLength(),
      this.limit,
      this.label,
    );
    this.element.textContent = message || "";
    this.element.hidden = !message;
    this.editor.element.setAttribute("aria-invalid", String(Boolean(message)));
    return !message;
  }

  read() {
    return this.validate() ? this.editor.getText() : undefined;
  }

  sync(value) {
    const source = InputBudget.source(value);
    const current = this.editor.getBuffer().getTextSnapshot();
    if (!current.equals(source)) this.editor.setText(source);
    this.validate();
  }

  dispose() {
    this.element.remove();
    this.editor.element.removeAttribute("aria-invalid");
  }
};
