/**
 * Production audit — pure logic.
 *
 * The I/O lives in scripts/production-audit.mjs; everything here is
 * decidable from data so it can be tested without a network.
 *
 * WHY THIS EXISTS. Every bug that reached production in this project so
 * far shared one shape: the code was correct and the CONFIGURATION was
 * wrong, so no unit test could have caught any of them.
 *
 *   - NEXT_PUBLIC_SITE_URL unset  -> every share link pointed at
 *     localhost. Found by a person, days later.
 *   - NEXT_PUBLIC_BLOB_BASE_URL not declared as a Docker ARG -> the build
 *     behaved as if blob storage did not exist. R2 was serving perfectly
 *     the whole time.
 *   - The API started returning absolute image URLs -> og:image was
 *     dropped entirely and product links previewed as bare text.
 *   - next.config.ts gained an import the prod image did not copy -> the
 *     container crashed on every boot.
 *
 * None produced an error anywhere. Each was found by someone looking.
 * That is what this replaces.
 */

/** Severity ordering, worst first. */
export const SEVERITY = ["fail", "warn", "pass", "skip"];

/**
 * Overall run status: the worst severity present.
 *
 * A `warn` never fails the job. Free-tier spin-down, a marginal cert
 * window, or a deploy lagging main by a few minutes are all worth
 * REPORTING and none are worth waking someone for -- and an audit that
 * cries wolf gets muted, which is worse than not having one.
 */
export function overallStatus(results) {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}

/** Counts by status, for the report header. */
export function summarize(results) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/**
 * Whole days from `now` until `date`, rounded down.
 *
 * Used for every deadline check. Returns a negative number once the date
 * has passed, which callers treat as already-failed rather than as a
 * large positive window.
 */
export function daysUntil(date, now = new Date()) {
  const ms = new Date(date).getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Classifies a deadline into pass/warn/fail.
 *
 * Two thresholds because the useful signal is different at each: `warn`
 * means "schedule this", `fail` means "this is now urgent". A single
 * threshold either nags for weeks or gives no notice at all.
 */
export function classifyDeadline(days, { warnAt = 30, failAt = 7 } = {}) {
  if (days <= failAt) return "fail";
  if (days <= warnAt) return "warn";
  return "pass";
}

/**
 * Renders the report as Markdown.
 *
 * Grouped by area rather than listed flat, because the first question on
 * a red run is "which part of the system", not "which assertion".
 * Failures are listed first within each group.
 */
export function formatReport(results, { commit, when } = {}) {
  const counts = summarize(results);
  const status = overallStatus(results);
  const icon = { pass: "✅", warn: "⚠️", fail: "❌" }[status];

  const lines = [
    `## ${icon} Production audit — ${status.toUpperCase()}`,
    "",
    `${counts.pass} passed · ${counts.warn} warned · ${counts.fail} failed` +
      (counts.skip ? ` · ${counts.skip} skipped` : ""),
    "",
  ];

  if (when) lines.push(`_${when}_`, "");
  if (commit) lines.push(`Live build: \`${commit}\``, "");

  const areas = [...new Set(results.map((r) => r.area))];
  for (const area of areas) {
    const inArea = results
      .filter((r) => r.area === area)
      .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status));

    // A green area collapses to one line -- a report where everything is
    // equally prominent is one nobody reads to the end of.
    if (inArea.every((r) => r.status === "pass")) {
      lines.push(`### ✅ ${area} — all ${inArea.length} checks passed`, "");
      continue;
    }

    lines.push(`### ${area}`, "", "| | Check | Detail |", "|---|---|---|");
    for (const r of inArea) {
      const mark = { pass: "✅", warn: "⚠️", fail: "❌", skip: "⏭️" }[r.status];
      lines.push(`| ${mark} | ${r.name} | ${r.detail ?? ""} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * The issue title, kept STABLE so the workflow updates one issue instead
 * of opening a new one every night. A nightly job that files a fresh
 * issue per run buries the signal it exists to raise.
 */
export const ISSUE_TITLE = "Nightly production audit";

/**
 * The effective source list for images, honouring the CSP fallback chain.
 *
 * `csp.includes(host)` is not good enough and was wrong in both
 * directions: it passes when the origin appears in ANY directive --
 * connect-src, report-uri -- while img-src still blocks it, and it fails
 * on a policy like `img-src https:` that genuinely permits the host
 * without naming it.
 */
export function imageSourcesFrom(csp) {
  const directives = Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name.toLowerCase(), sources];
      }),
  );
  // img-src falls back to default-src when absent -- that is the CSP
  // spec's own rule, and ignoring it misreads a perfectly valid policy.
  return directives["img-src"] ?? directives["default-src"] ?? null;
}

/**
 * Whether a CSP actually permits loading images from `origin`.
 *
 * Returns null when no relevant directive exists, which means "not
 * restricted" rather than "blocked" -- a distinction the caller needs,
 * since those warrant different reporting.
 */
export function cspAllowsImageHost(csp, origin) {
  const sources = imageSourcesFrom(csp);
  if (!sources) return null;

  const { protocol, host } = new URL(origin);
  return sources.some((source) => {
    if (source === "*") return true;
    if (source === `${protocol}`) return true; // e.g. `https:`
    if (source === origin) return true;
    // A wildcard host: https://*.laxair.shop
    const wildcard = source.match(/^(https?:\/\/)?\*\.(.+)$/);
    if (wildcard) return host.endsWith(`.${wildcard[2]}`) || host === wildcard[2];
    return source.replace(/^https?:\/\//, "") === host;
  });
}

/**
 * Extracts an OpenGraph value, tolerating real-world HTML.
 *
 * The first version matched one exact serialization -- double quotes,
 * `property` before `content` -- and would report a perfectly valid page
 * as missing its tags. It also returned raw attribute text, so a URL
 * containing `&amp;` was fetched literally and 404'd.
 */
export function extractOgContent(html, property) {
  const tags = html.match(/<meta\s[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const prop = tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i)?.[1];
    if (prop?.toLowerCase() !== `og:${property}`.toLowerCase()) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content === undefined) continue;
    return decodeHtmlEntities(content);
  }
  return undefined;
}

/** The handful of entities that actually appear in URLs and titles. */
export function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}
