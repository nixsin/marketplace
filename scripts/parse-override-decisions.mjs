#!/usr/bin/env node
// Reads this PR's comments (fetched by the "Fetch prior override decisions"
// step in ci.yml via `gh api .../issues/$PR_NUMBER/comments`) and extracts
// the maintainer's override-decision log, if one exists, so the next
// ai-code-review.mjs run can avoid re-flagging a finding already fixed or
// explicitly disputed earlier in this same PR's thread. See CLAUDE.md's
// "AI code review gate" section for the full reasoning.
import { readFileSync } from "node:fs";
import {
  selectOverrideLogComment,
  parseOverrideLog,
} from "./lib/override-decisions.mjs";

const [commentsPath, authorizedLoginsArg] = process.argv.slice(2);
if (!commentsPath || !authorizedLoginsArg) {
  console.error(
    "Usage: parse-override-decisions.mjs <pr-comments.json> <comma-separated-authorized-logins>",
  );
  process.exit(1);
}

// Fail closed to "no override context" on any read/parse error. This is
// safe to fail closed on in the opposite sense from the rest of this job:
// missing context never weakens a guarantee, it just means the reviewer
// behaves exactly as it did before this feature existed.
try {
  const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
  const authorizedLogins = authorizedLoginsArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const body = selectOverrideLogComment(comments, authorizedLogins);
  console.log(JSON.stringify(parseOverrideLog(body)));
} catch (err) {
  console.error(
    `Failed to parse override decisions, defaulting to none: ${err.message}`,
  );
  console.log(JSON.stringify({ rows: [], recommendation: null }));
}
