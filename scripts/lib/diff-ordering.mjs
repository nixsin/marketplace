// Reorders a unified diff so the change's own subject comes first, and
// reduces it in tiers if it is genuinely enormous.
//
// Two problems this solves, both observed rather than theorized:
//
// 1. Attention. git emits files alphabetically, which has nothing to do
//    with what a change is about. PR #90 was 54% tests by volume and PR
//    #87 was 46% infrastructure; leading either with an unrelated source
//    file buries the actual subject. Models attend more to earlier
//    content, so this matters even when nothing is truncated.
//
// 2. Truncation shape. The previous behaviour was `diff.slice(0, LIMIT)`
//    -- a flat head-slice. On PR #94 that delivered 31 files complete and
//    8 files not at all: not partially, zero bytes, with no signal that
//    they existed. That is strictly worse than the same budget spread
//    across every file, and it is why the truncation safeguard had to
//    fail closed so bluntly.
//
// FOCUS IS DERIVED FROM THE DIFF, NEVER FROM AUTHOR NARRATIVE. The
// reviewers deliberately receive no PR title, description, branch name or
// commit message (see CLAUDE.md's "Hallucination/context-leaking
// defenses") so they cannot be led by the implementer's own framing.
// Ordering by any of those would partially reintroduce exactly that.
// Ranking by measured byte share is computed from the diff itself, so it
// stays honest.

/**
 * Categories in demotion order for ties. `generated` is pinned last no
 * matter how large it gets: a lockfile can dominate a diff by volume while
 * being worth nothing to review, and schema.gql is emitted from resolvers
 * that are already present in the same diff.
 */
export const CATEGORIES = ["source", "tests", "infra", "docs", "generated"];
export const NEVER_LEADS = new Set(["generated", "docs"]);

/**
 * Classify one path. Order matters -- the first match wins, so the
 * narrowest patterns come first.
 */
export function classifyFile(filePath) {
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(filePath)) return "generated";
  if (/(^|\/)schema\.gql$|(^|\/)generated\//.test(filePath)) return "generated";
  if (/\.md$/.test(filePath)) return "docs";
  // Separator is [.-]: this repo names its API suites `*.e2e-spec.ts`, which
  // a `\.spec\.` pattern misses. A `test/` or `tests/` directory counts too --
  // apps/api/test/ holds the entire e2e suite plus its helpers, none of
  // which match a filename pattern. Both gaps were found by classifying
  // PR #94's real diff and seeing products.e2e-spec.ts come back "source".
  if (/[.-](spec|test)\.[a-z]+$/.test(filePath)) return "tests";
  if (/(^|\/)(tests?|e2e|__tests__)\//.test(filePath)) return "tests";
  // Build/CI tooling classifies as infra even though it is hand-written
  // source. Without this, a CI-focused change like PR #98 (perf-budget.mjs
  // plus the review scripts) resolves to "source" and reports the wrong
  // subject -- checked against that real PR, not assumed.
  if (/^\.github\//.test(filePath)) return "infra";
  if (/(^|\/)(Dockerfile|docker-compose\.ya?ml|render\.yaml)$/.test(filePath)) return "infra";
  if (/\.config\.[a-z]+$/.test(filePath)) return "infra";
  if (/(^|\/)scripts\//.test(filePath)) return "infra";
  return "source";
}

/** Split a unified diff into per-file chunks, preserving each header. */
export function splitDiff(diffText) {
  if (!diffText.trim()) return [];
  const files = [];
  let current = null;
  for (const line of diffText.split("\n")) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (m) {
      if (current) files.push(current);
      const filePath = m[2];
      current = {
        path: filePath,
        category: classifyFile(filePath),
        isNew: false,
        lines: [line],
      };
    } else if (current) {
      if (line.startsWith("new file mode")) current.isNew = true;
      current.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files.map((f) => ({ ...f, text: f.lines.join("\n"), size: f.lines.join("\n").length }));
}

/**
 * Rank categories by measured byte share, biggest first, with `generated`
 * and `docs` pinned last regardless of volume.
 */
export function rankCategories(files) {
  const bytes = {};
  for (const f of files) bytes[f.category] = (bytes[f.category] ?? 0) + f.size;
  const leading = CATEGORIES.filter((c) => !NEVER_LEADS.has(c) && bytes[c]);
  leading.sort((a, b) => bytes[b] - bytes[a]);
  const trailing = CATEGORIES.filter((c) => NEVER_LEADS.has(c) && bytes[c]);
  return { order: [...leading, ...trailing], bytes };
}

/** The change's own subject: the largest category that can lead. */
export function focusOf(files) {
  const { order } = rankCategories(files);
  return order.find((c) => !NEVER_LEADS.has(c)) ?? null;
}

/**
 * Order files: by ranked category, then new files before modified ones
 * (new code has had no prior review; a modification is a delta on
 * something already seen), then largest first.
 */
export function orderFiles(files) {
  const { order } = rankCategories(files);
  const rank = new Map(order.map((c, i) => [c, i]));
  return [...files].sort((a, b) => {
    const byCat = (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99);
    if (byCat !== 0) return byCat;
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return b.size - a.size;
  });
}

/**
 * Assemble the payload, reducing in tiers only if it genuinely does not
 * fit. Returns { text, truncated, notes }.
 *
 * `truncated` means REVIEWABLE CONTENT WAS LOST, not "bytes were removed"
 * -- and that distinction is the point. Dropping a lockfile costs the
 * review nothing, so it must not force REQUEST_CHANGES the way losing real
 * code does. Under the old all-or-nothing flag, every reduction blocked
 * the PR identically.
 */
export function buildDiffPayload(diffText, limit) {
  const files = splitDiff(diffText);
  if (files.length === 0) return { text: diffText, truncated: false, notes: [] };

  const ordered = orderFiles(files);
  const notes = [];
  const total = (list) => list.reduce((n, f) => n + f.size + 1, 0);

  // Tier 0 -- it fits. This is the expected path: the largest diff this
  // repo has ever produced is ~79KB.
  if (total(ordered) <= limit) {
    return { text: ordered.map((f) => f.text).join("\n"), truncated: false, notes };
  }

  // Tier 1 -- drop generated content. Not a review-quality loss, so this
  // alone does not set `truncated`.
  let kept = ordered.filter((f) => f.category !== "generated");
  for (const f of ordered) {
    if (f.category === "generated") notes.push(`omitted ${f.path} (generated, ${f.size} bytes)`);
  }
  if (total(kept) <= limit) {
    return { text: kept.map((f) => f.text).join("\n"), truncated: false, notes };
  }

  // Tier 2 -- proportional per-file budget. Every remaining file keeps its
  // header and a share; none is silently dropped, which is the specific
  // failure the head-slice produced.
  const overhead = kept.length * 80;
  const share = Math.max(200, Math.floor((limit - overhead) / kept.length));
  const reduced = kept.map((f) => {
    if (f.size <= share) return f.text;
    notes.push(`truncated ${f.path} to ~${share} of ${f.size} bytes`);
    return `${f.text.slice(0, share)}\n[... ${f.size - share} bytes of ${f.path} omitted ...]`;
  });
  return { text: reduced.join("\n"), truncated: true, notes };
}

/** A human/model-readable manifest of what was reduced, or "". */
export function renderNotes(notes) {
  if (notes.length === 0) return "";
  return [
    "## Diff reductions",
    "The diff below was reduced to fit. Do not treat an omitted or truncated",
    "file as reviewed -- say so explicitly instead.",
    ...notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
}
