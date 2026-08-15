import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import compat from "eslint-plugin-compat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Catches a browser-compatibility regression at lint time instead of in
  // production — reads the browserslist field in package.json (Chrome/
  // Safari/Firefox/Edge, last 2 versions) as the target, so this checks
  // against our actual declared Tier 1 support, not a generic default.
  compat.configs["flat/recommended"],
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
