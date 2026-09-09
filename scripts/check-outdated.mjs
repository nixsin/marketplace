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
 *   scripts/check-outdated.mjs <outdated-json-file> <allowlist-file> <pnpm-status>
 *
 * `pnpm-status` is `pnpm outdated`'s own exit code and is REQUIRED, because
 * it is the only thing that makes an empty file trustworthy. pnpm exits 0
 * when nothing is outdated and 1 when something is, so the workflow has to
 * swallow that 1 — which also swallows a registry, auth or config failure,
 * and those produce no stdout. Without the status, "pnpm could not run" is
 * byte-identical to "nothing is outdated" and this check passes while
 * checking nothing.
 *
 * Optional would have been the same hole with extra steps: any caller that
 * forgot it would silently get the unvouched behaviour back.
 */
const [outdatedPath, allowlistPath, pnpmStatus] = process.argv.slice(2);

/**
 * Every way the inputs can be untrustworthy, in one place.
 *
 * Returns the outdated map, or null having already reported why. Written as
 * one function rather than checks scattered down the file because each
 * round of review found another gap in the same class — a malformed input
 * being read as "clean" — and the fix for a class is one place to be right.
 */
function loadInputs() {
  if (!outdatedPath || !allowlistPath || pnpmStatus === undefined) {
    console.error(
      "Usage: scripts/check-outdated.mjs <outdated-json-file> <allowlist-file> <pnpm-status>",
    );
    process.exitCode = EXIT_INPUT_ERROR;
    return null;
  }

  // Only 0 and 1 are pnpm reporting a result at all.
  if (!["0", "1"].includes(pnpmStatus)) {
    inputError(
      `pnpm outdated exited ${pnpmStatus} — refusing to report "no outdated packages" from output it did not produce.`,
    );
    return null;
  }

  let raw;
  try {
    raw = readFileSync(outdatedPath, "utf8").trim();
    allowlist = readFileSync(allowlistPath, "utf8");
  } catch (error) {
    inputError(`could not read its inputs: ${error.message}`);
    return null;
  }

  // Status 0 with no output is the ordinary everything-current case. The
  // status-1 contradiction is checked once, below, against the PARSED map --
  // an empty string and an empty object are the same claim, and checking
  // only the string left `{}` accepted.
  if (raw === "" && pnpmStatus === "0") return {};

  let parsed;
  try {
    // "" is not JSON; treat it as the empty map so the one invariant below
    // reports it, rather than a parse error that hides the real problem.
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch (error) {
    inputError(`could not parse ${outdatedPath}: ${error.message}`);
    return null;
  }

  // Valid JSON is not the same as the shape expected. `[]` would report
  // "No outdated packages" and pass; `null` would throw out of
  // Object.keys and exit 1, which reads as a dependency finding.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    inputError(
      `expected a package map in ${outdatedPath}, got ${Array.isArray(parsed) ? "an array" : String(parsed === null ? "null" : typeof parsed)}.`,
    );
    return null;
  }

  // THE invariant, and it is a BICONDITIONAL: pnpm exits 1 exactly when it
  // found outdated packages, so status and result must agree in both
  // directions. Only the first half was checked at first, which is how each
  // round of review kept finding another way through — the whole point of
  // stating it as one equivalence is that there is no "other half" left.
  //
  // Checked against the PARSED map rather than the raw text, because "" and
  // "{}" are the same claim.
  const foundSome = Object.keys(parsed).length > 0;
  if ((pnpmStatus === "1") !== foundSome) {
    inputError(
      pnpmStatus === "1"
        ? 'pnpm outdated exited 1 ("found outdated packages") but reported none — refusing to treat that as clean.'
        : "pnpm outdated exited 0 (\"nothing outdated\") but reported packages — refusing to classify a result its own status contradicts.",
    );
    return null;
  }

  return parsed;
}

let allowlist;
const outdated = loadInputs();

if (outdated !== null) report(outdated, allowlist);

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
