/**
 * Repository hygiene checks that were previously done by eye.
 *
 * Both of these were performed by hand while writing docs/*.md, and both
 * are the kind of thing a person does correctly nine times and then
 * misses on the tenth -- with very different consequences:
 *
 *   A committed credential enters git history PERMANENTLY. Deleting the
 *   line does not remove it; the only real remedy is rotating the key.
 *
 *   A rotted doc link is minor on its own, but the infrastructure docs
 *   are the thing someone reads during an incident, when following a
 *   dead cross-reference costs exactly the time they do not have.
 */

/** Patterns that look like a real credential VALUE, not a variable name. */
const SECRET_PATTERNS = [
  // AWS/R2-style access key id. No trailing \b: the id is followed by
  // whatever quoting the line uses, and requiring a word boundary after
  // exactly 16 chars silently matched nothing.
  { name: "access key id", re: /\b(AKIA|ASIA)[A-Z0-9]{16}/ },
  // An assignment whose right-hand side is a long opaque string. Excludes
  // anything that is obviously a placeholder or an env var reference.
  {
    name: "assigned secret",
    // The keyword may sit anywhere inside the identifier --
    // `secret_access_key`, `BLOB_SECRET_ACCESS_KEY`, `apiToken`. The first
    // version anchored the keyword immediately before the `=`, so the most
    // likely real name in this repo did not match and the whole check
    // quietly passed on everything.
    re: /[A-Za-z0-9_]*(secret|token|password|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*["']?([A-Za-z0-9+/_-]{24,})["']?/i,
  },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/**
 * Values that MATCH a pattern above but are not secrets.
 *
 * Without this the check fires on its own documentation and on the env
 * var NAMES the codebase deliberately stores instead of values -- and a
 * guard that cries wolf gets disabled, which is worse than not having it.
 */
const ALLOWED = [
  /\$\{?[A-Z_]+\}?/,          // an env var reference
  /<[^>]+>/,                    // a <placeholder>
  /process\.env\./,
  /xxx+|placeholder|example|changeme|your[-_]?key/i,
];

/**
 * An explicit, visible opt-out for a line that must contain something
 * secret-shaped -- a test fixture, or documentation of the pattern itself.
 *
 * A marker rather than a file-level exclusion: excluding this scanner's
 * own test file would work today, but it hides the exemption, and the
 * next file needing one would get excluded wholesale too. The marker sits
 * on the line it applies to, where a reviewer already is.
 */
const IGNORE_MARKER = "scan-ignore";

/** Findings for one file's contents. */
export function scanForSecrets(path, contents) {
  const findings = [];
  contents.split("\n").forEach((line, i) => {
    if (line.includes(IGNORE_MARKER)) return;
    // A line that is clearly naming a variable rather than assigning a
    // value -- the pattern this repo uses everywhere on purpose.
    if (ALLOWED.some((a) => a.test(line))) return;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        findings.push({ path, line: i + 1, kind: name });
        break;
      }
    }
  });
  return findings;
}

/**
 * Relative markdown links, with their anchors.
 *
 * Returns `{ target, anchor }` so the caller can check the file exists
 * and, when an anchor is present, that a heading actually produces it.
 */
export function extractRelativeLinks(markdown) {
  const links = [];
  for (const m of markdown.matchAll(/\]\((\.\/[^)\s]+?)(#[^)\s]+)?\)/g)) {
    links.push({ target: m[1], anchor: m[2]?.slice(1) });
  }
  return links;
}

/**
 * GitHub's heading-to-anchor slug.
 *
 * Lowercase, strip anything that is not alphanumeric/space/hyphen, then
 * spaces to hyphens. Matching GitHub's real behaviour matters: an anchor
 * that looks right but does not resolve is exactly the failure this is
 * meant to catch.
 */
export function headingSlugs(markdown) {
  return markdown
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        // Each space becomes its own hyphen -- GitHub does NOT collapse
        // runs. A heading like "Setup — nameserver delegation" loses the
        // em-dash but keeps both surrounding spaces, producing a DOUBLE
        // hyphen. Collapsing here reported three perfectly valid links as
        // dead, which would have made the check worse than useless: it
        // would have pressured someone into "fixing" working anchors.
        .replace(/ /g, "-"),
    );
}
