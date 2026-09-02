#!/usr/bin/env node
/**
 * Write the config files the environment contract owns.
 *
 *   apps/api/.env.example    every API variable, with its localhost value
 *   apps/web/.env.example    every web variable, likewise
 *   docker/dev.env           the hostnames that differ inside compose
 *
 * Modes:
 *   (none)     write the files
 *   --check    exit 1 if a committed file differs from what we would write
 *
 * `--check` runs in CI. Without it the generator is a suggestion: someone
 * edits a rule, forgets to regenerate, and the committed file quietly
 * describes a contract that no longer exists.
 *
 * Imported by RELATIVE path, like ci-env.mjs: jobs that run this may not have
 * installed the workspace, so the package specifier would not resolve.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  renderDockerEnv,
  renderEnvExample,
} from "../packages/config/src/env-contract.js";

const FILES = [
  { path: "apps/api/.env.example", render: () => renderEnvExample("api") },
  { path: "apps/web/.env.example", render: () => renderEnvExample("web") },
  { path: "docker/dev.env", render: renderDockerEnv },
];

// An unknown flag is refused, not ignored. The two modes do OPPOSITE things:
// `--chek` would silently rewrite every file and exit 0, so someone who meant
// to verify would be told they had, having just overwritten the evidence.
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--check");
if (unknown.length > 0) {
  console.error(
    `Unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}\n` +
      `Usage:  node scripts/generate-env-example.mjs [--check]`,
  );
  process.exit(2);
}

const check = args.includes("--check");
const resolve = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Trailing-newline-insensitive, so an editor's final newline is not a diff. */
const normalise = (text) => `${text.trimEnd()}\n`;

const stale = [];
for (const { path, render } of FILES) {
  const wanted = normalise(render());
  const full = resolve(path);

  if (check) {
    let committed;
    try {
      committed = readFileSync(full, "utf8");
    } catch {
      stale.push(`${path} (missing)`);
      continue;
    }
    if (normalise(committed) !== wanted) stale.push(path);
    continue;
  }

  mkdirSync(resolve(path.replace(/\/[^/]+$/, "")), { recursive: true });
  writeFileSync(full, wanted);
  console.log(`wrote ${path}`);
}

if (!check) process.exit(0);

if (stale.length === 0) {
  console.log("env files are up to date");
  process.exit(0);
}

console.error(
  `These files no longer match the contract:\n` +
    stale.map((p) => `  ${p}`).join("\n") +
    `\n\nRun:  node scripts/generate-env-example.mjs`,
);
process.exit(1);
