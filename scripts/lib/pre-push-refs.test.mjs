import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPushedCommit, branchNameFromRef } from "./pre-push-refs.mjs";

const ZERO = "0".repeat(40);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("single non-delete ref returns its local sha and ref", () => {
  const stdin = `refs/heads/feature ${SHA_A} refs/heads/feature ${ZERO}\n`;
  assert.deepEqual(selectPushedCommit(stdin), {
    sha: SHA_A,
    localRef: "refs/heads/feature",
  });
});

test("delete-only push skips", () => {
  const stdin = `refs/heads/feature ${ZERO} refs/heads/feature ${SHA_A}\n`;
  const result = selectPushedCommit(stdin);
  assert.ok(result.skip, "expected a skip result");
});

test("empty stdin skips", () => {
  const result = selectPushedCommit("");
  assert.ok(result.skip, "expected a skip result");
});

test("whitespace-only stdin skips", () => {
  const result = selectPushedCommit("   \n\n  \n");
  assert.ok(result.skip, "expected a skip result");
});

test("multiple non-delete refs in one push skips rather than guessing", () => {
  const stdin = [
    `refs/heads/a ${SHA_A} refs/heads/a ${ZERO}`,
    `refs/heads/b ${SHA_B} refs/heads/b ${ZERO}`,
  ].join("\n");
  const result = selectPushedCommit(stdin);
  assert.ok(result.skip, "expected a skip result");
});

test("one delete ref alongside one real ref returns the real one", () => {
  const stdin = [
    `refs/heads/deleted-branch ${ZERO} refs/heads/deleted-branch ${SHA_A}`,
    `refs/heads/feature ${SHA_B} refs/heads/feature ${ZERO}`,
  ].join("\n");
  assert.deepEqual(selectPushedCommit(stdin), {
    sha: SHA_B,
    localRef: "refs/heads/feature",
  });
});

test("pushing local branch to a differently-named remote ref still uses the local sha/ref", () => {
  // e.g. `git push origin fix-branch:main` — the exact case the first AI
  // review finding named: reviewing the pushed sha, not whatever HEAD
  // happens to be. localRef here is fix-branch, NOT main, since that's
  // what the override-decision-log lookup needs to key off of too (see the
  // second finding, which caught that fetchOverrideDecisions used the
  // checked-out branch instead of this).
  const stdin = `refs/heads/fix-branch ${SHA_A} refs/heads/main ${SHA_B}\n`;
  assert.deepEqual(selectPushedCommit(stdin), {
    sha: SHA_A,
    localRef: "refs/heads/fix-branch",
  });
});

test("branchNameFromRef strips refs/heads/ prefix", () => {
  assert.equal(branchNameFromRef("refs/heads/fix-branch"), "fix-branch");
});

test("branchNameFromRef returns null for a tag ref (no PR/override-log concept)", () => {
  assert.equal(branchNameFromRef("refs/tags/v1.0"), null);
});

test("branchNameFromRef returns null for undefined/missing input", () => {
  assert.equal(branchNameFromRef(undefined), null);
});
