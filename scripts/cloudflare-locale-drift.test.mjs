import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The Cloudflare bypass for locale-negotiated paths is built from a
// Terraform `locales` variable, because the expression has to name every
// locale prefix that must NOT be bypassed. That list also lives in
// packages/config/src/index.js as LOCALES, and Terraform cannot import JS.
//
// Two declarations of one fact, kept in step only by a comment, is exactly
// the invariant packages/config was created to eliminate -- see CLAUDE.md
// on the JS budget being declared twice. So it is asserted here instead of
// remembered.
//
// Drifting is not a loud failure. Add a locale to the app without adding it
// here and the new locale's pages stop being cacheable, because the bypass
// no longer excludes them. Remove one and its paths silently become
// cacheable locale-negotiated redirects -- one visitor's language served to
// everyone, which is the bug this whole rule exists to prevent.

const readLocales = (file, pattern) => {
  const source = readFileSync(path.resolve(file), "utf8");
  const match = source.match(pattern);
  assert.ok(match, `could not read the locale list from ${file}`);
  return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
};

test("Terraform's locales match the web app's LOCALES", () => {
  const app = readLocales(
    "packages/config/src/index.js",
    /export const LOCALES\s*=[^[]*\[([^\]]*)\]/,
  );
  const terraform = readLocales(
    "infra/terraform/cloudflare/variables.tf",
    /variable "locales"[\s\S]*?default\s*=\s*\[([^\]]*)\]/,
  );

  assert.ok(app.length > 0, "no locales parsed from packages/config");
  assert.deepEqual(
    terraform,
    app,
    `infra/terraform/cloudflare/variables.tf declares [${terraform}] but the app serves [${app}]. ` +
      "Adding a locale in only one place stops the new locale caching, or turns its paths into " +
      "shared-cacheable locale-negotiated redirects.",
  );
});

test("the bypass expression names every locale it must exclude", () => {
  const main = readFileSync(
    path.resolve("infra/terraform/cloudflare/main.tf"),
    "utf8",
  );
  // Built by interpolation over var.locales rather than hardcoded, so the
  // expression cannot list a subset of the variable.
  assert.match(
    main,
    /for l in var\.locales/,
    "the negotiated-path bypass must be derived from var.locales, not hardcoded",
  );
});
