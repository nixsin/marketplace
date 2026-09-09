#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { classifyOutdated } from "./lib/check-outdated.mjs";

/**
 * Decides whether dependency-freshness.yml's check passes, given pnpm
 * outdated's own JSON and this repo's allowlist of known-blocked packages.
 *
 * A thin wrapper on purpose: every decision lives in
 * lib/check-outdated.mjs so the tests exercise the real code path rather
 * than a parallel copy, the same split as ci-progress-comment and
 * pr-reconciliation.
 *
 * Fails (exit 1) ONLY for a major-version gap that is not on the allowlist.
 * Same-major gaps are printed and do not fail — Dependabot opens a grouped
 * minor-and-patch PR weekly, so a red badge there reports nothing the PR
 * queue does not already carry, while going red on essentially every
 * publish. Measured on 2026-09-08: a CI run flagged three packages, and
 * bumping all three flagged three DIFFERENT ones an hour later.
 *
 * Everything is printed either way, so "does not fail" never means "not
 * shown."
 *
 * Usage: scripts/check-outdated.mjs <outdated-json-file> <allowlist-file>
 */
const [outdatedPath, allowlistPath] = process.argv.slice(2);
if (!outdatedPath || !allowlistPath) {
  console.error(
    "Usage: scripts/check-outdated.mjs <outdated-json-file> <allowlist-file>",
  );
  process.exit(2);
}

// `pnpm outdated` writes nothing when everything is current, so an empty
// file is the ordinary success case rather than a malformed input.
const raw = readFileSync(outdatedPath, "utf8").trim();
const outdated = raw ? JSON.parse(raw) : {};
const allowlist = readFileSync(allowlistPath, "utf8");

const names = Object.keys(outdated);
if (names.length === 0) {
  console.log("No outdated packages.");
  process.exit(0);
}

console.log("Outdated packages:");
for (const name of names.sort()) {
  console.log(`  ${name}: ${outdated[name]?.current} -> ${outdated[name]?.latest}`);
}
console.log();

const { sameMajor, actionable } = classifyOutdated(outdated, allowlist);

if (sameMajor.length > 0) {
  console.log(
    "Same-major updates (Dependabot's weekly grouped PR covers these — not failing):",
  );
  for (const name of sameMajor) console.log(`  ${name}`);
  console.log();
}

if (actionable.length === 0) {
  console.log("No unaccounted MAJOR updates — nothing actionable right now.");
  process.exit(0);
}

console.log(
  `MAJOR updates NOT on the allowlist (actionable) — see ${allowlistPath}:`,
);
for (const name of actionable) console.log(`  ${name}`);
process.exit(1);
