/**
 * Drift checks for ci.yml's environment values.
 *
 * ci.yml cannot import JavaScript, so it declares these values literally and
 * this keeps them equal to the contract — the same approach that pins
 * Terraform to LOCALES.
 *
 * Every function takes the workflow SOURCE rather than reading the file, so
 * each rejection branch can be tested against a fixture. They were verified
 * by hand-editing the real ci.yml before that, which proved the logic and
 * left nothing behind to catch a regression.
 *
 * These are regex scans, not YAML parsing, and that is a deliberate limit:
 * `test-ci-scripts` runs without `pnpm install`, so no parser is available,
 * and hand-rolling one is the trap that produced this repo's .env-parser
 * bugs. `unreadableSpellings` below turns what the scans cannot read into a
 * failure instead of a silent gap.
 */

/** Variables whose value or placement can break a job destructively. */
export const WATCHED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_API_URL",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
];

const WATCHED_RE = `(?:${WATCHED.join("|")})`;

/** One job's lines, from its key to the next job's. */
export function jobSource(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const end = lines.findIndex(
    (l, i) => i > start && /^  [a-z][\w-]*:\s*$/.test(l),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/**
 * `NAME: value` pairs under the `env:` at exactly `indent` spaces.
 *
 * The indentation is required, not inferred. Taking the FIRST `env:` in a
 * job returned a service container's block whenever one appeared above the
 * job-level one — so a job could have no job-level env at all while the
 * check read a service's and passed, leaving every
 * `${{ env.DATABASE_URL }}` in that job resolving to nothing.
 *
 * Job-level is 4; a service container's is 8.
 */
export function envBlock(text, indentOf = 4) {
  if (!text) return null;
  const lines = text.split("\n");
  const header = " ".repeat(indentOf) + "env:";
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;

  const indent = indentOf + 2;
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) < indent) break;
    const m = /^\s*([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) break;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The workflow-level `env:` — required at column 0.
 *
 * Not merely the first `env:` before `jobs:`: a `workflow_dispatch` input
 * named `env` is nested and would otherwise be taken for it.
 */
export function workflowEnv(source) {
  const head = source.slice(0, source.indexOf("\njobs:"));
  const lines = head.split("\n");
  const start = lines.findIndex((l) => l === "env:");
  if (start === -1) return {};
  return envBlock(lines.slice(start).join("\n"), 0) ?? {};
}

/** Job names that assign DATABASE_URL anywhere in their body. */
export function jobsAssigningDatabaseUrl(source) {
  const out = new Set();
  let job = null;
  for (const line of source.split("\n")) {
    const m = /^  ([a-z][\w-]*):\s*$/.exec(line);
    if (m) job = m[1];
    if (job && /^\s+DATABASE_URL:/.test(line)) out.add(job);
  }
  return [...out];
}

/**
 * Spellings GitHub accepts and the scans above cannot read.
 *
 * Each would slip past every other check here — including the one keeping a
 * DATABASE_URL out of test-api-e2e, where it points that suite at the dev
 * database and its beforeEach truncates every table.
 *
 * @returns {string[]} One description per offending line; empty when clean.
 */
export function unreadableSpellings(source) {
  const offenders = [];

  source.split("\n").forEach((line, i) => {
    const at = `line ${i + 1}: ${line.trim()}`;

    if (new RegExp(`^\\s*["']${WATCHED_RE}["']\\s*:`).test(line)) {
      offenders.push(`${at}   (quoted key)`);
      return;
    }
    // A quoted key carrying a backslash escape. YAML resolves `"\u0044ATABASE_URL"`
    // to DATABASE_URL, which the exact-name test above cannot see. Nothing
    // this workflow legitimately writes needs an escape in a key — the only
    // quoted keys here are inside an embedded JSON heredoc, which has none.
    if (/^\s*"[^"]*\\[^"]*"\s*:/.test(line)) {
      offenders.push(`${at}   (escaped key)`);
      return;
    }
    if (new RegExp(`^\\s*${WATCHED_RE}\\s+:`).test(line)) {
      offenders.push(`${at}   (space before colon)`);
      return;
    }
    // An anchor or alias moves a whole env map somewhere these scans never
    // look: `env: *database_env` assigns variables that appear nowhere in
    // the job's own text.
    if (/^\s*env:\s*[*&]/.test(line)) {
      offenders.push(`${at}   (YAML anchor or alias)`);
      return;
    }
    if (new RegExp(`^\\s*${WATCHED_RE}:\\s*[*&]`).test(line)) {
      offenders.push(`${at}   (YAML anchor or alias)`);
      return;
    }

    // `${{ ... }}` is an Actions expression, not a YAML flow map, and it
    // contains braces — so it comes out before asking about braces, or every
    // legitimate reference reads as an inline map.
    const yamlOnly = line.replace(/\$\{\{[^}]*\}\}/g, "");
    if (
      /^\s*env:\s*\{/.test(yamlOnly) ||
      (yamlOnly.includes("{") && new RegExp(`${WATCHED_RE}\\s*:`).test(yamlOnly))
    ) {
      offenders.push(`${at}   (inline map)`);
    }
  });

  return offenders;
}
