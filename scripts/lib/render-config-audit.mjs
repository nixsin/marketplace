/**
 * Does production carry the configuration the repo declares?
 *
 * The nightly audit checks whether production WORKS — it is up, its headers
 * are right, its caches behave. It never checked whether production is
 * CONFIGURED the way the repository says, and that is where every problem
 * found on 2026-09-05 lived:
 *
 *   seven variables set directly on the services, overriding the Terraform
 *   env groups, so `terraform apply` reported success while production kept
 *   the old values
 *
 *   no way to answer "does each service have every variable the contract
 *   requires" without writing a throwaway script — which got it wrong on the
 *   first attempt and reported thirteen absent variables that were present
 *
 * Both questions are answered against packages/config/src/env-contract.js,
 * already the single source of truth for what should exist.
 *
 * FAILS CLOSED, like the shadow report it sits beside: an unreadable
 * response or a lookup that did not complete raises rather than returning
 * "nothing wrong". The reassuring answer is the dangerous one here, because
 * nobody re-checks a green line.
 */

/**
 * Every env var name a service actually receives.
 *
 * The union of its own variables and every linked env group, because that is
 * what the container sees. Reading only one of the two answers a different
 * question than the one being asked: a variable absent from the service list
 * may be supplied by a group, or by nobody, and those are opposite
 * conclusions.
 *
 * @param {object} args
 * @param {string} args.serviceId
 * @param {() => Promise<string[]>} args.directNames    the service's own vars
 * @param {() => Promise<Array<{name: string, names: string[], serviceIds: string[]}>>} args.groups
 * @returns {Promise<{names: Set<string>, linked: string[]}>}
 */
export async function environmentSeenBy({ serviceId, directNames, groups }) {
  const names = new Set(await directNames());
  const linked = [];

  for (const group of await groups()) {
    // Linkage is read from the GROUP, not the service. Render exposes no
    // /services/{id}/env-groups — asking for one returns 404, which an
    // earlier version silently treated as "no groups linked" and turned into
    // thirteen false positives.
    if (!group.serviceIds.includes(serviceId)) continue;
    for (const name of group.names) names.add(name);
    linked.push(group.name);
  }

  return { names, linked };
}

/**
 * Contract variables a service does not receive.
 *
 * @param {Set<string>} seen
 * @param {Array<{name: string}>} contract
 * @returns {string[]}
 */
export function missingFromContract(seen, contract) {
  return contract.map((rule) => rule.name).filter((name) => !seen.has(name));
}

/**
 * The audit rows for one service.
 *
 * Two separate findings, deliberately, because they need different actions:
 *
 *   missing      the service cannot boot under the startup contract — fail
 *   shadowing    it boots, but Terraform is not what decides its values,
 *                so an apply can report success and change nothing — warn
 *
 * Collapsing them into one row would either page someone about hygiene or
 * bury a boot-blocker inside a warning.
 *
 * @param {object} args
 * @param {string} args.service       display name
 * @param {string[]} args.missing
 * @param {string[]} args.shadowing
 * @param {string[]} args.linked
 * @param {number} args.required
 */
export function configurationRows({ service, missing, shadowing, linked, required }) {
  const rows = [];

  rows.push({
    name: `${service} has every contract variable`,
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `${required}/${required} present via ${linked.length ? linked.join(", ") : "service variables"}`
        : `missing ${missing.length}: ${missing.join(", ")} — the service would refuse to boot`,
  });

  rows.push({
    name: `${service} reads its values from Terraform`,
    status: shadowing.length === 0 ? "pass" : "warn",
    detail:
      shadowing.length === 0
        ? "no service-level variable overrides an env group"
        : `${shadowing.length} set on the service, overriding the group: ` +
          `${shadowing.join(", ")} — terraform apply reports success and changes nothing`,
  });

  return rows;
}

/**
 * Every page of a cursor-paginated Render collection.
 *
 * `?limit=100` with no pagination silently truncates at 100, which breaks
 * BOTH directions of this audit: linked groups past the first page look
 * absent, so their variables read as missing, and service overrides past it
 * read as "nothing shadows the group". A fail-closed check that quietly
 * reads half the data is not fail-closed.
 *
 * A REPEATED CURSOR IS A STALL, not completion — the same rule
 * render-shadowed-env.mjs applies, for the same reason: treating it as done
 * reports on a partial list, and a cycle runs forever.
 *
 * @param {(cursor?: string) => Promise<unknown>} getPage
 * @returns {Promise<any[]>}
 */
export async function fetchAllPages(getPage) {
  const items = [];
  const seen = new Set();
  let cursor;

  for (;;) {
    const page = await getPage(cursor);
    if (!Array.isArray(page)) {
      throw new Error(
        `Render returned ${typeof page}, not a list. Refusing to report on a ` +
          `response this code cannot read.`,
      );
    }
    items.push(...page);

    const next = page[page.length - 1]?.cursor;
    if (page.length === 0 || !next) return items;
    if (seen.has(next)) {
      throw new Error(
        `Pagination looped: Render returned cursor ${next} again for a ` +
          `non-empty page. Refusing to report on a partial list.`,
      );
    }
    seen.add(next);
    cursor = next;
  }
}

/**
 * Every env group, with its variables, and every group that could not be read.
 *
 * UNREADABLE IS NOT EMPTY. Swallowing a failed detail lookup and carrying on
 * with an empty list makes that group's variables read as missing from every
 * service linked to it — a boot-failure finding drawn from data nobody has.
 * The two are reported separately so the message says which happened.
 *
 * @param {object} args
 * @param {(cursor?: string) => Promise<unknown>} args.listPage
 * @param {(id: string) => Promise<any>} args.detail
 */
export async function loadEnvGroups({ listPage, detail }) {
  const groups = [];
  const unreadable = [];

  for (const row of await fetchAllPages(listPage)) {
    const raw = row.envGroup ?? row;
    const name = raw.name ?? raw.id;
    const serviceIds = (raw.serviceLinks ?? []).map((l) => l.id ?? l.serviceId);
    let names = (raw.envVars ?? []).map((v) => v.key).filter(Boolean);

    // The list endpoint omits envVars on some plans, so an empty list is not
    // evidence the group is empty — it has to be asked directly.
    if (names.length === 0) {
      try {
        const full = await detail(raw.id);
        names = (full.envVars ?? []).map((v) => v.key).filter(Boolean);
      } catch (error) {
        unreadable.push({ name, error: error.message });
        continue;
      }
    }
    groups.push({ name, names, serviceIds });
  }

  return { groups, unreadable };
}
