import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The freshness workflow's own shell, which no other test can reach.
 *
 * lib/check-outdated.mjs is where the decision lives and it is covered
 * there. What is NOT covered by construction is the part that decides
 * whether the checker is given trustworthy inputs at all -- the registry
 * probe and the exit-status capture -- because that is shell inside a
 * workflow, and this workflow only runs on a schedule. A regression there
 * would reach main unnoticed and first surface at the next weekly run,
 * which is the same reason pr-reconciliation and ci-progress-comment are
 * tested here.
 *
 * These are content assertions, not an execution. They pin the properties
 * that are load-bearing and silent when broken; each was a real bug or a
 * real review finding rather than a guess at what might go wrong.
 */
const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/dependency-freshness.yml", import.meta.url)),
  "utf8",
);

/** The workflow with its `#` comments removed. */
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("the registry preflight runs BEFORE pnpm outdated", () => {
  // Order is the whole point and is silent when wrong: a probe after the
  // fact proves nothing about data already collected. Still asserted here
  // because ordering is the one thing that stayed in the shell.
  const preflight = code.indexOf("check-registry.mjs");
  const outdated = code.indexOf("pnpm outdated");
  assert.ok(preflight !== -1, "expected the registry preflight");
  assert.ok(outdated !== -1, "expected the pnpm outdated call");
  assert.ok(preflight < outdated, "the preflight must run before pnpm outdated");
});

test("the registry is passed IN, not read inside the script", () => {
  // What makes a failing `pnpm config get registry` reachable as a clean
  // exit 2 rather than aborting the step with pnpm's own status under
  // `bash -e`. Raised in review. `|| true` is the load-bearing half.
  assert.match(code, /registry=\$\(pnpm config get registry\) \|\| true/);
  assert.match(code, /check-registry\.mjs "\$registry"/);
});

test("the probe's own decisions are NOT in the shell", () => {
  // They were, for three review rounds, and each round found another way
  // through that no test could reach. The shell gathers; the library
  // decides -- the same split as pr-reconciliation and ci-progress-comment.
  assert.doesNotMatch(code, /curl /);
  assert.doesNotMatch(code, /-\/ping/);
});

test("pnpm's exit status is captured and passed to the checker", () => {
  // `set +e` is what makes the status readable at all -- under the default
  // `set -e` the step would abort on pnpm's own 1 before the assignment.
  // And the checker REQUIRES the status: dropping the argument silently
  // restores the behaviour where an empty file reads as "nothing
  // outdated".
  assert.match(code, /set \+e/);
  assert.match(code, /pnpm_status=\$\?/);
  assert.match(code, /check-outdated\.mjs[^\n]*"\$pnpm_status"/);
});
