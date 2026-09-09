import semver from "semver";

/**
 * Decides what `dependency-freshness.yml` should fail on.
 *
 * Split out of the workflow — and out of bash — for the reason this repo
 * already applies to pr-reconciliation and ci-progress-comment: the decision
 * is the part worth testing, and inline shell is where it stops being
 * testable.
 *
 * The parsing specifically is `semver`'s job, not ours. Two hand-rolled
 * versions of it were wrong in review, both in the same direction — quietly
 * treating a malformed value as a real version rather than as unknown:
 *
 *   1. stripping leading text and keeping the first number found, so
 *      "build1.alpha" and "release1-beta" both read as major 1 and compared
 *      EQUAL;
 *   2. a hand-written regex that still accepted "1.2.3-foo..bar" and
 *      "^ v =1.2.3".
 *
 * Each was individually fixable and that was the wrong response to the
 * second one. Version parsing has a specification and a canonical
 * implementation; matching it with a regex is a rewrite nobody asked for.
 */

/**
 * Major version of a well-formed version string, or `null` for anything
 * else — including a range like ">=1.2.3", which is not a version.
 *
 * `semver.coerce` is deliberately NOT used: it turns "build1.alpha" into
 * 1.0.0, which is exactly the guess this function exists to refuse.
 */
export function majorOf(value) {
  if (typeof value !== "string") return null;
  const parsed = semver.parse(value.trim(), { loose: true });
  return parsed ? parsed.major : null;
}

/** Allowlist entries, minus comments, blank lines and inline reasons. */
export function parseAllowlist(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/**
 * @param outdated  pnpm outdated --format json, as a parsed object
 * @param allowlist raw contents of known-outdated-packages.txt
 *
 * Returns three disjoint groups. Only `actionable` fails the check.
 *
 * A package whose version cannot be parsed on either side lands in
 * `actionable`, not `sameMajor`. Failing OPEN is deliberate: the cost of a
 * needless red is one look, and the cost of skipping it is that this check
 * stops covering the only case it still fails on.
 */
export function classifyOutdated(outdated, allowlist) {
  const allowed = new Set(parseAllowlist(allowlist));
  const groups = { allowlisted: [], sameMajor: [], actionable: [] };

  for (const name of Object.keys(outdated ?? {}).sort()) {
    if (allowed.has(name)) {
      groups.allowlisted.push(name);
      continue;
    }
    const current = majorOf(outdated[name]?.current);
    const latest = majorOf(outdated[name]?.latest);
    const known = current !== null && latest !== null;
    groups[known && current === latest ? "sameMajor" : "actionable"].push(name);
  }

  return groups;
}
