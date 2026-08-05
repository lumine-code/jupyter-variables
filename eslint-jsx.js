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
 * A tag compiles to a call on the factory, so it is also a use of whatever
 * identifier the factory hangs off. That is `etch` almost everywhere here, and
 * defaulting to it means only the React ports have to say so — which doubles as
 * a marker of the two packages that are the exception. Naming the wrong one is
 * not a quiet mistake: the real factory's import then reads as unused, and
 * `no-unused-vars` says exactly which identifier it was.
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
    schema: [
      {
        type: "object",
        properties: { pragma: { type: "string" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { sourceCode } = context;
    const { pragma = "etch" } = context.options[0] ?? {};

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
