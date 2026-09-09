#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { classifyOutdated } from "./lib/check-outdated.mjs";

/**
 * Exit codes, kept distinct on purpose: CI must be able to tell a
 * dependency finding from this script being unable to answer at all.
 *   0 nothing actionable   1 actionable major   2 could not run
 */
const EXIT_ACTIONABLE = 1;
const EXIT_INPUT_ERROR = 2;

function inputError(message) {
  console.error(`check-outdated: ${message}`);
  process.exitCode = EXIT_INPUT_ERROR;
}

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
 * Usage:
 *   scripts/check-outdated.mjs <outdated-json-file> <allowlist-file> [pnpm-status]
 *
 * `pnpm-status` is `pnpm outdated`'s own exit code, and passing it is what
 * keeps an EMPTY input honest. pnpm exits 0 when nothing is outdated and 1
 * when something is, so the workflow has to swallow that 1 — which also
 * swallows a registry, auth or config failure, and those produce no stdout.
 * Without the status, "pnpm could not run" is byte-identical to "nothing is
 * outdated" and this check passes while checking nothing. That is the silent
 * skip this repo keeps getting bitten by, so an unexpected status is refused
 * rather than reported as clean.
 */
const [outdatedPath, allowlistPath, pnpmStatus] = process.argv.slice(2);
if (!outdatedPath || !allowlistPath) {
  console.error(
    "Usage: scripts/check-outdated.mjs <outdated-json-file> <allowlist-file> [pnpm-status]",
  );
  process.exitCode = EXIT_INPUT_ERROR;
}

let outdated;
let allowlist;
if (process.exitCode !== EXIT_INPUT_ERROR) {
  // Only 0 and 1 are `pnpm outdated` reporting a result. Anything else is it
  // failing, and an empty file then means nothing at all.
  if (pnpmStatus !== undefined && !["0", "1"].includes(pnpmStatus)) {
    inputError(
      `pnpm outdated exited ${pnpmStatus} — refusing to report "no outdated packages" from output it did not produce.`,
    );
  } else {
    try {
      const raw = readFileSync(outdatedPath, "utf8").trim();
      // pnpm writes nothing when everything is current, so an empty file is
      // the ordinary success case — but only once the status above vouches
      // for it.
      outdated = raw ? JSON.parse(raw) : {};
      allowlist = readFileSync(allowlistPath, "utf8");
    } catch (error) {
      inputError(`could not read its inputs: ${error.message}`);
    }
  }
}

if (outdated === undefined) {
  // An input error was already reported and process.exitCode set.
} else {
  report(outdated, allowlist);
}

/**
 * `process.exitCode` throughout, never `process.exit()`. The latter can
 * terminate before asynchronously-written piped stdout has flushed, which
 * would quietly break the one guarantee this script makes — that every
 * outdated package is printed even when nothing fails.
 */
function report(entries, allowlistText) {
  const names = Object.keys(entries);
  if (names.length === 0) {
    console.log("No outdated packages.");
    return;
  }

  console.log("Outdated packages:");
  for (const name of names.sort()) {
    console.log(`  ${name}: ${entries[name]?.current} -> ${entries[name]?.latest}`);
  }
  console.log();

  const { sameMajor, actionable } = classifyOutdated(entries, allowlistText);

  if (sameMajor.length > 0) {
    console.log(
      "Same-major updates (Dependabot's weekly grouped PR covers these — not failing):",
    );
    for (const name of sameMajor) console.log(`  ${name}`);
    console.log();
  }

  if (actionable.length === 0) {
    console.log("No unaccounted MAJOR updates — nothing actionable right now.");
    return;
  }

  console.log(
    `MAJOR updates NOT on the allowlist (actionable) — see ${allowlistPath}:`,
  );
  for (const name of actionable) console.log(`  ${name}`);
  process.exitCode = EXIT_ACTIONABLE;
}
