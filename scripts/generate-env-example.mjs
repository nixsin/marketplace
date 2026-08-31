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
// RELATIVE, not `@medinstru/config/env-contract`. The `--check` mode runs in
// test-ci-scripts, a job with no `pnpm install` at all -- checkout and
// setup-node only -- so the package specifier does not resolve there. It
// resolved locally because pnpm happens to link the workspace package into
// the root node_modules, which is exactly the "works on my machine" shape
// this repo keeps getting caught by.
import {
  renderDockerEnv,
  renderEnvExample,
} from "../packages/config/src/env-contract.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

let stale = false;

/** Compare or write one generated file. */
function emit(path, generated, label) {
  if (!check) {
    writeFileSync(path, generated);
    console.log(`wrote ${label}`);
    return false;
  }
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Missing counts as stale rather than crashing: the fix is the same.
  }
  if (current === generated) return false;
  console.error(`${label} is out of date. Run: node scripts/generate-env-example.mjs`);
  return true;
}

// The two Docker-network overrides, so docker-compose.yml carries no env
// literals of its own.
stale =
  emit(
    join(repoRoot, "apps", "api", ".env.docker"),
    renderDockerEnv(),
    "apps/api/.env.docker",
  ) || stale;

for (const app of ["api", "web"]) {
  stale =
    emit(
      join(repoRoot, "apps", app, ".env.example"),
      renderEnvExample(app),
      `apps/${app}/.env.example`,
    ) || stale;
}

process.exit(stale ? 1 : 0);
