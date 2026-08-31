#!/usr/bin/env node
/**
 * Write apps/{api,web}/.env.example from the environment contract.
 *
 *   node scripts/generate-env-example.mjs           # write the files
 *   node scripts/generate-env-example.mjs --check   # fail if they are stale
 *
 * `.env.example` was the last hand-maintained copy of the variable list, and a
 * copy is a thing that drifts -- silently, in the direction where a variable
 * exists in the contract and simply never appears in the file CI copies.
 * Generating it makes the contract the only place a variable is declared,
 * described, or given a development value.
 *
 * The --check mode runs in CI (test-ci-scripts), so a rule added without
 * regenerating fails there rather than months later.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderEnvExample } from "@medinstru/config/env-contract";

const repoRoot = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

let stale = false;
for (const app of ["api", "web"]) {
  const path = join(repoRoot, "apps", app, ".env.example");
  const generated = renderEnvExample(app);

  if (!check) {
    writeFileSync(path, generated);
    console.log(`wrote apps/${app}/.env.example`);
    continue;
  }

  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Missing counts as stale rather than crashing: the fix is the same.
  }

  if (current !== generated) {
    console.error(
      `apps/${app}/.env.example is out of date. Run: node scripts/generate-env-example.mjs`,
    );
    stale = true;
  }
}

process.exit(stale ? 1 : 0);
