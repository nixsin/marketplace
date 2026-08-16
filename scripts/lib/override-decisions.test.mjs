import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERRIDE_LOG_MARKER,
  selectOverrideLogComment,
  parseOverrideLog,
  flattenPaginatedComments,
} from "./override-decisions.mjs";

const validLog = `${OVERRIDE_LOG_MARKER}
### AI reviewer override log

| Reviewer finding | My resolution | Status |
|---|---|---|
| missing null check on \`x\` | Fixed in commit abc123 | Resolved |
| flagged \`Y\` as unsafe | Disagree — Y is bounded by Z, see PR comment | Overridden |

**Recommendation:** APPROVE — no blocking issues remain.`;

test("selectOverrideLogComment: picks a comment with marker + authorized login", () => {
  const comments = [
    { login: "nixsin", body: validLog, updated_at: "2026-08-15T00:00:00Z" },
  ];
  assert.equal(selectOverrideLogComment(comments, ["nixsin"]), validLog);
});

test("selectOverrideLogComment: marker alone from an unauthorized login is rejected", () => {
  const comments = [
    {
      login: "some-random-commenter",
      body: validLog,
      updated_at: "2026-08-15T00:00:00Z",
    },
  ];
  assert.equal(selectOverrideLogComment(comments, ["nixsin"]), null);
});

test("selectOverrideLogComment: authorized login without the marker is ignored", () => {
  const comments = [
    {
      login: "nixsin",
      body: "just a regular comment, no marker here",
      updated_at: "2026-08-15T00:00:00Z",
    },
  ];
  assert.equal(selectOverrideLogComment(comments, ["nixsin"]), null);
});

test("selectOverrideLogComment: empty/missing comments returns null, doesn't throw", () => {
  assert.equal(selectOverrideLogComment([], ["nixsin"]), null);
  assert.equal(selectOverrideLogComment(undefined, ["nixsin"]), null);
});

test("selectOverrideLogComment: multiple matches picks the most recently updated", () => {
  const older = {
    login: "nixsin",
    body: `${OVERRIDE_LOG_MARKER}\nold version`,
    updated_at: "2026-08-10T00:00:00Z",
  };
  const newer = {
    login: "nixsin",
    body: `${OVERRIDE_LOG_MARKER}\nnew version`,
    updated_at: "2026-08-15T00:00:00Z",
  };
  assert.equal(
    selectOverrideLogComment([older, newer], ["nixsin"]),
    newer.body,
  );
});

test("parseOverrideLog: extracts rows and recommendation from a well-formed log", () => {
  const { rows, recommendation } = parseOverrideLog(validLog);
  assert.deepEqual(rows, [
    {
      finding: "missing null check on `x`",
      resolution: "Fixed in commit abc123",
      status: "Resolved",
    },
    {
      finding: "flagged `Y` as unsafe",
      resolution: "Disagree — Y is bounded by Z, see PR comment",
      status: "Overridden",
    },
  ]);
  assert.equal(recommendation, "APPROVE — no blocking issues remain.");
});

test("parseOverrideLog: null/empty body returns empty rows, no recommendation", () => {
  assert.deepEqual(parseOverrideLog(null), { rows: [], recommendation: null });
  assert.deepEqual(parseOverrideLog(""), { rows: [], recommendation: null });
});

test("parseOverrideLog: no table at all returns empty rows", () => {
  const body = `${OVERRIDE_LOG_MARKER}\nJust prose, no table.\n\n**Recommendation:** REQUEST_CHANGES — still blocked on X.`;
  const { rows, recommendation } = parseOverrideLog(body);
  assert.deepEqual(rows, []);
  assert.equal(recommendation, "REQUEST_CHANGES — still blocked on X.");
});

test("parseOverrideLog: malformed row (too few cells) is skipped, not thrown", () => {
  const body = `${OVERRIDE_LOG_MARKER}
| Reviewer finding | My resolution | Status |
|---|---|---|
| only one cell |
| complete row | resolved it | Resolved |`;
  const { rows } = parseOverrideLog(body);
  assert.deepEqual(rows, [
    { finding: "complete row", resolution: "resolved it", status: "Resolved" },
  ]);
});

// Real bug from a live review: a naive split("|") mis-splits any
// finding/resolution text that legitimately contains a pipe (a shell
// pipe, a TypeScript union type, `a || b`), silently shifting
// resolution/status into the wrong column instead of erroring or
// skipping. Standard Markdown table syntax escapes a literal pipe as
// `\|` — this must split on unescaped pipes only, then unescape `\|`
// back to `|` in the cell content, the same two-step handling a real
// Markdown renderer does.
test("parseOverrideLog: an escaped pipe in a cell doesn't shift the columns", () => {
  const body = `${OVERRIDE_LOG_MARKER}
| Reviewer finding | My resolution | Status |
|---|---|---|
| uses \\| in a shell pipeline | fixed by quoting the pipeline | Resolved |`;
  const { rows } = parseOverrideLog(body);
  assert.deepEqual(rows, [
    {
      finding: "uses | in a shell pipeline",
      resolution: "fixed by quoting the pipeline",
      status: "Resolved",
    },
  ]);
});

test("parseOverrideLog: multiple escaped pipes in one cell all unescape correctly", () => {
  const body = `${OVERRIDE_LOG_MARKER}
| Reviewer finding | My resolution | Status |
|---|---|---|
| type is string \\| number \\| boolean | narrowed the union | Resolved |`;
  const { rows } = parseOverrideLog(body);
  assert.equal(rows[0].finding, "type is string | number | boolean");
});

// Real bug from a live review of this feature's introducing PR: `gh api
// --paginate --jq` runs the jq filter per page, so a multi-page comments
// fetch produced several concatenated JSON arrays rather than one valid
// value, and JSON.parse silently failed closed to "no override context"
// on any PR with enough comments to paginate. The fix moved flattening
// into JS against the raw `--paginate --slurp` shape: an outer array of
// pages, each page itself the raw array of GitHub comment objects.
test("flattenPaginatedComments: flattens multiple pages of raw GitHub comment objects in order", () => {
  const page1 = [
    { user: { login: "nixsin" }, body: "first", updated_at: "2026-08-14T00:00:00Z" },
    { user: { login: "github-actions[bot]" }, body: "second", updated_at: "2026-08-14T01:00:00Z" },
  ];
  const page2 = [
    { user: { login: "nixsin" }, body: "third", updated_at: "2026-08-15T00:00:00Z" },
  ];
  assert.deepEqual(flattenPaginatedComments([page1, page2]), [
    { login: "nixsin", body: "first", updated_at: "2026-08-14T00:00:00Z" },
    { login: "github-actions[bot]", body: "second", updated_at: "2026-08-14T01:00:00Z" },
    { login: "nixsin", body: "third", updated_at: "2026-08-15T00:00:00Z" },
  ]);
});

test("flattenPaginatedComments: a single page (gh --slurp still wraps it in an outer array) works the same way", () => {
  const page1 = [{ user: { login: "nixsin" }, body: "only comment", updated_at: "2026-08-15T00:00:00Z" }];
  assert.deepEqual(flattenPaginatedComments([page1]), [
    { login: "nixsin", body: "only comment", updated_at: "2026-08-15T00:00:00Z" },
  ]);
});

test("flattenPaginatedComments: no pages / empty pages returns an empty array, doesn't throw", () => {
  assert.deepEqual(flattenPaginatedComments([]), []);
  assert.deepEqual(flattenPaginatedComments([[]]), []);
  assert.deepEqual(flattenPaginatedComments(undefined), []);
});

test("flattenPaginatedComments: a comment with no user field doesn't throw, login is undefined", () => {
  const page1 = [{ body: "orphaned comment", updated_at: "2026-08-15T00:00:00Z" }];
  assert.deepEqual(flattenPaginatedComments([page1]), [
    { login: undefined, body: "orphaned comment", updated_at: "2026-08-15T00:00:00Z" },
  ]);
});

test("parseOverrideLog: recommendation line is optional", () => {
  const body = `${OVERRIDE_LOG_MARKER}
| Reviewer finding | My resolution | Status |
|---|---|---|
| some finding | some resolution | Resolved |`;
  const { recommendation } = parseOverrideLog(body);
  assert.equal(recommendation, null);
});
