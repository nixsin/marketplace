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

test("the registry is probed, and BEFORE pnpm outdated runs", () => {
  // Order is the whole point and is silent when wrong: a probe after the
  // fact proves nothing about the data already collected.
  const probe = code.indexOf("curl -fsS");
  const outdated = code.indexOf("pnpm outdated");
  assert.ok(probe !== -1, "expected a registry probe");
  assert.ok(outdated !== -1, "expected the pnpm outdated call");
  assert.ok(probe < outdated, "the probe must run before pnpm outdated");
});

test("the probe fetches package metadata, not just a liveness ping", () => {
  // A registry can serve a public ping while refusing metadata, and
  // metadata is the request pnpm actually makes. Raised in review.
  assert.match(code, /curl -fsS[^\n]*\$\{registry%\/\}\/semver/);
  assert.doesNotMatch(code, /curl -fsS[^\n]*\/-\/ping/);
});

test("a failed probe exits 2, never 1", () => {
  // 1 is "an actionable major was found" -- a dependency finding. 2 is
  // "could not run". Collapsing them makes a registry outage read as a
  // real upgrade someone then goes looking for.
  const block = code.slice(code.indexOf("curl -fsS"));
  assert.match(block.slice(0, 300), /exit 2/);
});

test("the failure message logs the ORIGIN, never the configured registry", () => {
  // A registry URL can carry userinfo (https://user:pass@host/), which
  // would put a credential in a public workflow log. Raised in review.
  const echoes = code.match(/echo "check-outdated:[^"]*"/g) ?? [];
  assert.ok(echoes.length > 0, "expected a diagnostic on probe failure");
  for (const line of echoes) {
    assert.ok(
      line.includes("${registry_origin}"),
      `expected the sanitised origin in: ${line}`,
    );
    assert.doesNotMatch(
      line,
      /\$\{registry\}|\$registry\b/,
      `raw registry value must not be logged: ${line}`,
    );
  }
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
