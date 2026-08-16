// Pure parsing logic for the maintainer's "override-decision log" — a
// single edit-in-place PR comment (same pattern as the `changes` job's
// `<!-- ci-skip-logic-comment -->`) where the implementer records, as a
// table, every ai-code-review finding they fixed or explicitly disputed.
// ai-code-review.mjs feeds this back into the next review round so the
// stateless reviewer doesn't re-flag something already resolved — see
// CLAUDE.md's "AI code review gate" section for the full reasoning. No I/O
// in this file (see scripts/parse-override-decisions.mjs for that) so the
// selection/parsing logic is independently testable.

export const OVERRIDE_LOG_MARKER = "<!-- ai-review-override-log -->";

// `gh api ... --paginate --jq '[...]'` runs the jq filter once PER PAGE,
// so multi-page output is several JSON arrays emitted back-to-back — not
// one valid JSON value. `--slurp` fixes that but is mutually exclusive
// with `--jq` (gh CLI rejects the combination outright), so the caller
// fetches raw pages with `--paginate --slurp` (no `--jq`) and this
// function does the flattening/shaping in JS instead, where it's
// testable against a real multi-page shape. A live review caught this on
// this exact feature's introducing PR: a PR with enough comments to
// paginate would silently lose override context (JSON.parse throwing,
// caught by the fail-closed default) without ever surfacing as an error.
export function flattenPaginatedComments(pages) {
  return (pages ?? []).flat().map((c) => ({
    login: c.user?.login,
    body: c.body,
    updated_at: c.updated_at,
  }));
}

// Trust boundary: the marker string alone is not enough to treat a comment
// as authoritative. This repo's PRs are publicly commentable, and the whole
// point of the reviewer's prompt-injection defenses elsewhere is to never
// let untrusted thread content pose as a legitimate instruction or a
// settled decision. Only a comment from an explicitly authorized login
// (passed in by the caller — see ci.yml's use of `github.repository_owner`)
// is eligible, regardless of what marker it contains.
export function selectOverrideLogComment(comments, authorizedLogins) {
  const candidates = (comments ?? []).filter(
    (c) =>
      typeof c.body === "string" &&
      c.body.trimStart().startsWith(OVERRIDE_LOG_MARKER) &&
      authorizedLogins.includes(c.login),
  );
  if (candidates.length === 0) return null;

  // Edit-in-place means there should only ever be one, but pick the most
  // recently updated defensively rather than assuming that invariant holds.
  candidates.sort(
    (a, b) => new Date(b.updated_at ?? 0) - new Date(a.updated_at ?? 0),
  );
  return candidates[0].body;
}

function splitRow(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

// Not security-critical the way verdict extraction is — a botched parse
// here only means the reviewer gets less context than it could, never a
// false approval, since none of the mechanical fail-closed checks
// (files-reviewed match, truncation override, single-verdict-heading rule)
// read this output. So this stays intentionally simple: find the row
// deemed the table separator, take every `|`-prefixed line after it as
// (finding, resolution, status).
export function parseOverrideLog(commentBody) {
  if (!commentBody) return { rows: [], recommendation: null };

  const lines = commentBody.split("\n");
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  const separatorIndex = tableLines.findIndex((l) =>
    isSeparatorRow(splitRow(l)),
  );

  const rows =
    separatorIndex === -1
      ? []
      : tableLines
          .slice(separatorIndex + 1)
          .map(splitRow)
          .filter((cells) => cells.length >= 3 && cells[0].length > 0)
          .map(([finding, resolution, status]) => ({
            finding,
            resolution,
            status,
          }));

  const recMatch = commentBody.match(/\*\*Recommendation:?\*\*\s*(.+)/i);
  const recommendation = recMatch ? recMatch[1].trim() : null;

  return { rows, recommendation };
}
