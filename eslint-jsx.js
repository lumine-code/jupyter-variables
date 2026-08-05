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
 * `pragma` is required rather than defaulted: a tag compiles to a call on that
 * identifier -- `etch.dom` for an etch component, `React.createElement` for a
 * React one -- which is usually the only thing keeping its require used. Naming
 * it at the call site is what lets this file stay identical in every package
 * that carries it.
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
    // Spelled as a whole-array schema rather than the positional shorthand,
    // which has no way to say that an option must be present at all. Omitting
    // the pragma is then a config error, not a rule that silently marks nothing.
    schema: {
      type: "array",
      items: [
        {
          type: "object",
          properties: { pragma: { type: "string" } },
          required: ["pragma"],
          additionalProperties: false,
        },
      ],
      minItems: 1,
      maxItems: 1,
    },
  },
  create(context) {
    const { sourceCode } = context;
    const { pragma } = context.options[0];

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
