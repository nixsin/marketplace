/**
 * Which contract variables are set DIRECTLY on a Render service?
 *
 * Render's rule: "If a service defines an environment variable in its
 * individual settings, that value always takes precedence over any linked
 * environment groups that also define the variable." Linking a group removes
 * nothing.
 *
 * So a direct variable shadows Terraform's, silently and with no error
 * anywhere — Terraform reports a clean apply while production keeps the old
 * value, and a later rotation of JWT_SECRET or DATABASE_URL does nothing at
 * all. This is the decision half, kept pure so it can be tested without a
 * Render account.
 */

/**
 * @param {{service: string, app: string, names: string[]}[]} services  Direct
 *   env var names per service, each tagged with the contract that governs
 *   it, as returned by Render's API.
 * @param {Record<string, {name: string}[]>} contracts  CONTRACTS.
 * @returns {{service: string, shadowed: string[]}[]}  Only services with a
 *   problem; empty when the migration is complete.
 */
export function shadowedVariables(services, contracts) {
  return services
    .map(({ service, app, names }) => {
      // EACH SERVICE AGAINST ITS OWN CONTRACT. A single union across both
      // reported an API variable set on the WEB service as shadowing —
      // telling an operator to delete configuration that conflicts with
      // nothing, since the web group never sets it.
      const declared = new Set(
        (contracts[app] ?? []).map((rule) => rule.name),
      );
      return {
        service,
        shadowed: names.filter((name) => declared.has(name)).sort(),
      };
    })
    .filter(({ shadowed }) => shadowed.length > 0);
}

/** A report a person can act on: which service, which keys, what to do. */
export function formatShadowReport(findings) {
  if (findings.length === 0) {
    return "No contract variable is set directly on a service — the env groups are authoritative.";
  }

  const lines = [
    "These are set directly on a service, so they SHADOW the Terraform env group:",
    "",
  ];
  for (const { service, shadowed } of findings) {
    lines.push(`  ${service}`);
    for (const name of shadowed) lines.push(`    ${name}`);
  }
  lines.push(
    "",
    "Delete them from the service's own Environment tab in the Render dashboard.",
    "Until then Terraform reports a clean apply while production keeps the old",
    "value, and changing one here does nothing at all.",
  );
  return lines.join("\n");
}

/**
 * Env var names from one page of Render's list response.
 *
 * FAILS CLOSED. The first version treated a non-array payload as "this
 * service has no variables" and skipped any item whose key it did not
 * recognise — so a Render schema change would have produced "the env groups
 * are authoritative" while shadowing variables sat there unread. That is the
 * worst available answer: it is the reassuring one.
 *
 * @param {unknown} page
 * @returns {{names: string[], cursor: string | undefined}}
 * @throws {Error} when the shape is not what this code knows how to read.
 */
export function parseEnvVarPage(page) {
  if (!Array.isArray(page)) {
    throw new Error(
      `Render returned ${typeof page}, not a list of env vars. Refusing to ` +
        `report "no shadowing" from a response this code cannot read.`,
    );
  }

  const names = [];
  for (const item of page) {
    const key = item?.envVar?.key ?? item?.key;
    if (typeof key !== "string") {
      throw new Error(
        `An env var entry carried no readable key: ${JSON.stringify(item)?.slice(0, 120)}`,
      );
    }
    names.push(key);
  }

  return { names, cursor: page[page.length - 1]?.cursor };
}

/**
 * What to do after a page: stop, or fetch the next cursor?
 *
 * A REPEATED CURSOR IS A STALL, not completion. Treating it as "done" reads
 * a partial list and then reports that the env groups are authoritative —
 * the same fail-open shape as an unreadable page, arriving through the loop
 * instead of the parser.
 *
 * @param {{names: string[], cursor: string | undefined}} page
 * @param {string | undefined} previous  The cursor used to fetch this page.
 * @returns {{done: boolean, cursor?: string}}
 * @throws {Error} when pagination made no progress.
 */
export function nextPage(page, previous) {
  if (page.names.length === 0 || !page.cursor) return { done: true };

  if (page.cursor === previous) {
    throw new Error(
      `Pagination stalled: Render returned the same cursor (${page.cursor}) ` +
        `for a non-empty page. Refusing to report on a partial list.`,
    );
  }
  return { done: false, cursor: page.cursor };
}
