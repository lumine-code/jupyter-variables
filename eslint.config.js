const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
const jsx = require("./eslint-jsx");

module.exports = [
  {
    // Vendored kernel examples and the local dev sandbox ship as-is.
    ignores: ["node_modules/**", ".dev/**", "examples/**", "assets/**"],
  },
  js.configs.recommended,
  {
    // `.jsx` is not one of eslint's default extensions, and the etch components
    // live in those files.
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      // The default parser reads everything here now that the mobx decorators
      // are gone; JSX is the only syntax extension left, and espree knows it.
      parserOptions: { ecmaFeatures: { jsx: true } },
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
        atom: "readonly",
      },
    },
    plugins: { jsx },
    rules: {
      // fs.F_OK and friends are runtime deprecated (DEP0176) and slated for
      // removal; the constants live on fs.constants.
      "no-restricted-properties": [
        "error",
        ...["F_OK", "R_OK", "W_OK", "X_OK"].map((constant) => ({
          object: "fs",
          property: constant,
          message: `Use fs.constants.${constant} instead: fs.${constant} is deprecated (DEP0176).`,
        })),
      ],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Each file names its own JSX factory in a `/** @jsx ... */` pragma:
      // `require-pragma` insists on it, and `jsx-uses` reads it from there
      // rather than from a default that lives in another repository.
      "jsx/require-pragma": "error",
      "jsx/jsx-uses": "error",
    },
  },
  {
    // This config and its helper are dev tooling, loaded by eslint as CommonJS.
    files: ["eslint.config.js", "eslint-jsx.js", "prettier.config.js"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    // Specs run in the Lumine jasmine runner.
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: { globals: { ...globals.jasmine } },
  },
  // Must be last: turns off lint rules that would conflict with Prettier.
  prettier,
];
