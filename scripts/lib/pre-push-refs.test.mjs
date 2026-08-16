import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPushedCommit } from "./pre-push-refs.mjs";

const ZERO = "0".repeat(40);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("single non-delete ref returns its local sha", () => {
  const stdin = `refs/heads/feature ${SHA_A} refs/heads/feature ${ZERO}\n`;
  assert.deepEqual(selectPushedCommit(stdin), { sha: SHA_A });
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
  assert.deepEqual(selectPushedCommit(stdin), { sha: SHA_B });
});

test("pushing local branch to a differently-named remote ref still uses the local sha", () => {
  // e.g. `git push origin fix-branch:main` — the exact case the AI review
  // finding named: reviewing the pushed sha, not whatever HEAD happens to be.
  const stdin = `refs/heads/fix-branch ${SHA_A} refs/heads/main ${SHA_B}\n`;
  assert.deepEqual(selectPushedCommit(stdin), { sha: SHA_A });
});
