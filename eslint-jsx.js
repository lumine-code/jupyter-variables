/**
 * Minimal stand-in for eslint-plugin-react's `jsx-uses-react` and
 * `jsx-uses-vars` rules.
 *
 * Those two rules do nothing but tell `no-unused-vars` that a JSX tag counts as
 * a reference to the component (and to the pragma identifier). Without them
 * every component import in this package reads as unused. eslint-plugin-react
 * still caps its peer range at eslint 9, so the behaviour is reimplemented here
 * rather than pinning the whole toolchain back a major version.
 *
 * The pragma here is `etch`, passed in by the config: a tag compiles to a call
 * on `etch.dom`, which is the only thing keeping that require used.
 */

// `<Foo />` references `Foo`; `<a.b.c />` references `a`; `<div />` is an
// intrinsic element and resolves to no variable at all.
function rootIdentifier(name) {
  let node = name;
  while (node && node.type === "JSXMemberExpression") node = node.object;
  return node && node.type === "JSXIdentifier" ? node : null;
}

const jsxUses = {
  meta: {
    type: "problem",
    docs: { description: "Count JSX tags as references to the identifiers they name." },
    schema: [{ type: "object", properties: { pragma: { type: "string" } } }],
  },
  create(context) {
    const { sourceCode } = context;
    // Any JSX in the file compiles down to a use of the factory's root
    // identifier, which the config supplies.
    const pragma = (context.options[0] && context.options[0].pragma) || "etch";

    function markPragma(node) {
      sourceCode.markVariableAsUsed(pragma, node);
    }

    return {
      JSXOpeningElement(node) {
        markPragma(node);
        const identifier = rootIdentifier(node.name);
        if (identifier) sourceCode.markVariableAsUsed(identifier.name, identifier);
      },
      JSXOpeningFragment: markPragma,
    };
  },
};

module.exports = { rules: { "jsx-uses": jsxUses } };
