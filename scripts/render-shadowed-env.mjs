#!/usr/bin/env node
/**
 * Report contract variables set directly on a Render service.
 *
 * Those shadow the Terraform env groups — Render always prefers a service's
 * own variable — so while any exist, Terraform is not authoritative and a
 * change to a shadowed key silently does nothing.
 *
 *   RENDER_API_KEY=... node scripts/render-shadowed-env.mjs
 *
 * Exits 1 when something is shadowed, so it can gate a migration or run in a
 * job once the key is available to one. There is no such job today: the key
 * is not wired into any workflow, which is why this is a command you run
 * rather than a check that runs itself.
 */
import { CONTRACTS } from "../packages/config/src/env-contract.js";
import {
  formatShadowReport,
  shadowedVariables,
} from "./lib/render-shadowed-env.mjs";

// Each service is checked against ITS OWN contract: a variable the other
// app declares is not a conflict here, because this service's group never
// sets it.
const SERVICES = [
  { service: "medinstru-api", app: "api", id: "srv-da02lnojo6nc73djh9bg" },
  { service: "medinstru-web", app: "web", id: "srv-da02mt61egvs73fopb00" },
];

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error(
    "RENDER_API_KEY is not set. Export it in your own shell — this script\n" +
      "never stores it, and nothing in the repository holds a Render credential.",
  );
  process.exit(2);
}

/**
 * Every env var name on a service, FOLLOWING THE CURSOR.
 *
 * One page of 100 looked like enough and is not: a service with more would
 * have had its later keys missed, and the script would then report that the
 * groups are authoritative while a shadowing variable sat on page two.
 */
async function envVarNames(id, label) {
  const names = [];
  let cursor;

  for (;;) {
    const url = new URL(`https://api.render.com/v1/services/${id}/env-vars`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) {
      console.error(
        `Render returned ${response.status} for ${label}. The key needs read ` +
          `access to this service.`,
      );
      process.exit(2);
    }

    // Each item wraps the variable and carries the cursor for the next page.
    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) break;

    for (const item of page) {
      const key = item?.envVar?.key ?? item?.key;
      if (typeof key === "string") names.push(key);
    }

    const next = page[page.length - 1]?.cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return names;
}

const services = [];
for (const { service, app, id } of SERVICES) {
  services.push({ service, app, names: await envVarNames(id, service) });
}

const findings = shadowedVariables(services, CONTRACTS);
console.log(formatShadowReport(findings));
process.exit(findings.length === 0 ? 0 : 1);
