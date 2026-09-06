import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Lint for scripts/ and packages/config/ — 19,000 lines that nothing linted.
 *
 * apps/web and apps/api have had their own configs since the beginning; the
 * operational half of this repo never did. That is where most of the CI
 * logic, the environment contract and the production audit live.
 *
 * TWO RULES ARE THE POINT, and both come from a real mistake:
 *
 *   no-floating-promises   a dropped `await` in a script fails as an
 *                          unhandled rejection at 08:00 in a nightly audit,
 *                          not at review. It is type-aware, which is why
 *                          tsconfig.lint.json exists.
 *
 *   no .then()             one test was written as a promise chain while
 *                          every other file uses await. Same behaviour,
 *                          two idioms, and the chain hides rejections more
 *                          easily.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "apps/**",
      "infra/**",
      // Declaration files carry no runtime code, so the promise rules have
      // nothing to say about them -- and the type-checked configs error out
      // on any file the `files` globs below do not cover.
      "**/*.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "packages/config/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "module",
      parserOptions: {
        // `project`, not `projectService`. The service's
        // `allowDefaultProject` globs only match files at the root, so every
        // scripts/*.mjs came back "not found by the project service". Naming
        // the tsconfig directly uses its own `include`, which is where the
        // list of linted files belongs anyway.
        project: ["./tsconfig.lint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // THE MISSING-AWAIT RULE. An error rather than a warning: in a script
      // the symptom is a silent unhandled rejection, and a warning in an
      // unlinted-until-now directory is one nobody will act on.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test's `test()` returns a promise the RUNNER owns. Nobody
          // awaits it, and flagging it buried the real findings under ~600
          // false positives -- the state in which a new rule gets switched
          // off rather than fixed.
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it", "before", "after", "beforeEach", "afterEach"] },
          ],
        },
      ],
      // Its sibling: a promise passed where a sync value is expected, such
      // as an async callback to .filter().
      "@typescript-eslint/no-misused-promises": "error",

      // PREFER await TO .then(). No plugin for this: a selector is exact
      // enough and adds no dependency. Catches `.then(` on anything, which
      // in this codebase is always a promise.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='then']",
          message:
            "Use `await` rather than `.then()` — one idiom, and a chain " +
            "hides rejections more easily. If you genuinely need a chain, " +
            "disable this rule on the line and say why.",
        },
      ],

      // `.catch()` is deliberately NOT banned alongside `.then()`. It is the
      // remedy `no-floating-promises` itself recommends, and `main().catch()`
      // is the ordinary ESM entry-point idiom -- the only two uses in this
      // codebase. Banning it would make the two rules contradict each other.

      // These directories are plain JS with JSDoc. The unsafe-* family fires
      // on every untyped value, which is most of them -- that is a
      // type-annotation project, not this one.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
