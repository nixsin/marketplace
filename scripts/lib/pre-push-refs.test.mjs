import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPushedCommit, branchNameFromRef } from "./pre-push-refs.mjs";

const ZERO = "0".repeat(40);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("single non-delete ref returns its local sha, local ref, and remote ref", () => {
  const stdin = `refs/heads/feature ${SHA_A} refs/heads/feature ${ZERO}\n`;
  assert.deepEqual(selectPushedCommit(stdin), {
    sha: SHA_A,
    localRef: "refs/heads/feature",
    remoteRef: "refs/heads/feature",
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
    remoteRef: "refs/heads/feature",
  });
});

test("renamed push keeps localRef and remoteRef distinct — sha still follows the local commit", () => {
  // e.g. `git push origin fix-branch:main` — the diffed commit must be
  // fix-branch's actual content (localSha), but the PR this update
  // logically belongs to (if any) is main's, not any PR that happens to
  // share the name "fix-branch" — see branchNameFromRef(remoteRef) below.
  // A second AI review round caught that using localRef here was wrong for
  // exactly this reason.
  const stdin = `refs/heads/fix-branch ${SHA_A} refs/heads/main ${SHA_B}\n`;
  assert.deepEqual(selectPushedCommit(stdin), {
    sha: SHA_A,
    localRef: "refs/heads/fix-branch",
    remoteRef: "refs/heads/main",
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

test("override-decision lookup must use remoteRef, not localRef, for a renamed push", () => {
  // Directly exercises the third review round's finding: for
  // `fix-branch:main`, the branch name used to look up a PR's override
  // log must be "main" (remoteRef), never "fix-branch" (localRef).
  const stdin = `refs/heads/fix-branch ${SHA_A} refs/heads/main ${SHA_B}\n`;
  const selected = selectPushedCommit(stdin);
  assert.equal(branchNameFromRef(selected.remoteRef), "main");
  assert.notEqual(branchNameFromRef(selected.remoteRef), branchNameFromRef(selected.localRef));
});
