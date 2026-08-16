import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERRIDE_LOG_MARKER,
  selectOverrideLogComment,
  parseOverrideLog,
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

test("parseOverrideLog: recommendation line is optional", () => {
  const body = `${OVERRIDE_LOG_MARKER}
| Reviewer finding | My resolution | Status |
|---|---|---|
| some finding | some resolution | Resolved |`;
  const { recommendation } = parseOverrideLog(body);
  assert.equal(recommendation, null);
});
