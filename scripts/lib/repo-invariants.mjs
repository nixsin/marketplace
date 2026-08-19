// Pure detectors behind repo-invariants.test.mjs. Split out because these
// are bespoke parsers, and a parser asserted only against the current repo
// can pass while being unable to detect anything -- a review round on the
// first version found exactly that shape twice, so the detection logic gets
// fixtures of its own (repo-invariants.detectors.test.mjs) rather than
// being trusted because the live repo happens to be clean.
//
// Dependency-free by requirement, not preference: `test-ci-scripts` runs
// with no `pnpm install`, which is what lets it stay unconditional and
// unfiltered on every PR. No YAML parser is available, so these walk
// indentation explicitly. That is the whole reason nesting has to be
// handled deliberately below -- GitHub Actions reuses key names at
// different depths (`timeout-minutes` and `permissions` exist on both jobs
// and steps), so a naive /^\s+key:/m matches a step and reports a job as
// compliant when it isn't.

const JOB_INDENT = 2; // `  job-id:` under `jobs:`
const JOB_KEY_INDENT = 4; // `    runs-on:` etc.

/**
 * Split a workflow into { jobId: bodyText }. Only blocks that look like real
 * jobs (they declare runs-on) are returned.
 */
export function parseCiJobs(yamlText) {
  const lines = yamlText.split("\n");
  const blocks = {};
  let id = null;
  let buf = [];
  for (const line of lines) {
    const m = new RegExp(`^ {${JOB_INDENT}}([A-Za-z0-9_-]+):\\s*$`).exec(line);
    if (m) {
      if (id) blocks[id] = buf.join("\n");
      id = m[1];
      buf = [];
    } else if (id) {
      buf.push(line);
    }
  }
  if (id) blocks[id] = buf.join("\n");
  return Object.fromEntries(
    Object.entries(blocks).filter(([, body]) =>
      new RegExp(`^ {${JOB_KEY_INDENT}}runs-on:`, "m").test(body),
    ),
  );
}

/** True when `key` is declared at job level (not nested inside a step). */
export function hasJobLevelKey(jobBody, key) {
  return new RegExp(`^ {${JOB_KEY_INDENT}}${key}:`, "m").test(jobBody);
}

/**
 * True when the job declares permissions.contents: write specifically --
 * `permissions:` at job level, with `contents: write` nested directly under
 * it. Rejects a stray `contents: write` under `with:`/`env:`/a step.
 */
export function hasContentsWritePermission(jobBody) {
  const lines = jobBody.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^ {${JOB_KEY_INDENT}}permissions:\\s*$`).test(l),
  );
  if (start === -1) return false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= JOB_KEY_INDENT) break; // left the permissions block
    if (/^contents:\s*write\s*$/.test(line.trim())) return true;
  }
  return false;
}

/** Job ids lacking a job-level timeout-minutes. */
export function jobsMissingTimeout(jobs) {
  return Object.entries(jobs)
    .filter(([, body]) => !hasJobLevelKey(body, "timeout-minutes"))
    .map(([id]) => id);
}

/** Job ids that publish a badge but lack permissions.contents: write. */
export function badgeJobsMissingWrite(jobs) {
  return Object.entries(jobs)
    .filter(([, body]) => body.includes("publish-badge.sh"))
    .filter(([, body]) => !hasContentsWritePermission(body))
    .map(([id]) => id);
}

/** The entries of a job's `needs:` list, flow or block style. */
export function needsList(jobBody) {
  const flow = /^ {4}needs:\s*\n?\s*\[([\s\S]*?)\]/m.exec(jobBody);
  if (flow) {
    return flow[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const block = /^ {4}needs:\s*\n((?: {6}- .*\n?)+)/m.exec(jobBody);
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
  }
  const inline = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(jobBody);
  return inline ? [inline[1]] : [];
}

/**
 * `gh api -f key=@path` occurrences. -f treats `@...` as a literal string;
 * only -F/--field reads the file. Covers the long option and quoting.
 */
export function findFileFlagMisuse(text) {
  const re = /(?:-f|--raw-field)[= ]+['"]?[A-Za-z_][A-Za-z0-9_]*=@/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * `--paginate` combined with a jq filter that CONSTRUCTS a value.
 *
 * Narrower than "never combine --paginate --jq", deliberately: the filter
 * runs once per page, which is harmless when it emits a stream of scalars
 * (extra pages just append lines) and broken when it builds a JSON value,
 * since each page then emits its own complete document. Three correct
 * stream-style usages exist in this repo -- flagging them would train the
 * reader to ignore this check.
 *
 * Handles either option order, `--jq=`, and single/double/unquoted filters.
 */
export function findConstructingPaginateJq(text) {
  const hits = [];
  for (const line of text.split("\n")) {
    if (!line.includes("--paginate")) continue;
    const jq = /--jq[= ]+(['"]?)\s*([[{])/.exec(line);
    if (jq) hits.push(line.trim());
  }
  return hits;
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Active (non-negated, non-commented) glob entries of one key inside the
 * paths-filter config. `!packages/**` is an EXCLUSION -- treating it as
 * satisfying the rule would invert the rule's meaning.
 */
export function filterEntries(yamlText, key) {
  // Line-based rather than one large regex. The first version used a
  // multi-line pattern whose `\s*` alternative matched across newlines and
  // silently swallowed the entries it was meant to collect -- it returned
  // [] for a perfectly valid block. Caught by this module's own fixtures,
  // which is precisely why they exist.
  const lines = yamlText.split("\n");
  const header = new RegExp(`^(\\s+)${escapeRegExp(key)}:\\s*$`);
  let keyIndent = null;
  const entries = [];

  for (const line of lines) {
    if (keyIndent === null) {
      const m = header.exec(line);
      if (m) keyIndent = m[1].length;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break; // dedented out of this key's block
    const item = /^-\s+(.*)$/.exec(line.trim());
    if (!item) break; // a nested mapping, not a list of globs
    entries.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
  }

  if (keyIndent === null) return null;
  // `!glob` is an EXCLUSION -- counting it as present would invert the rule.
  return entries.filter((entry) => !entry.startsWith("!"));
}
