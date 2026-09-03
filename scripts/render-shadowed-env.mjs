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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACTS } from "../packages/config/src/env-contract.js";
import {
  formatShadowReport,
  parseEnvVarPage,
  shadowedVariables,
} from "./lib/render-shadowed-env.mjs";

// IDs read from Terraform, not copied. Duplicating them meant this script
// could inspect one service while the env groups were linked to another —
// and then report "authoritative" about a service that receives nothing.
const main = readFileSync(
  fileURLToPath(new URL("../infra/terraform/render/main.tf", import.meta.url)),
  "utf8",
);

function serviceId(local) {
  const m = new RegExp(`${local}\\s*=\\s*"(srv-[a-z0-9]+)"`).exec(main);
  if (!m) {
    console.error(
      `Could not read ${local} from infra/terraform/render/main.tf. ` +
        `Refusing to guess which service to inspect.`,
    );
    process.exit(2);
  }
  return m[1];
}

// Each service is checked against ITS OWN contract: a variable the other app
// declares is not a conflict here, because this service's group never sets it.
const SERVICES = [
  { service: "medinstru-api", app: "api", id: serviceId("api_service_id") },
  { service: "medinstru-web", app: "web", id: serviceId("web_service_id") },
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

    // Parsed by a function that THROWS on a shape it does not recognise,
    // rather than returning nothing and reading as "no shadowing".
    const page = await response.json();
    if (Array.isArray(page) && page.length === 0) break;

    let parsed;
    try {
      parsed = parseEnvVarPage(page);
    } catch (error) {
      console.error(`${label}: ${error.message}`);
      process.exit(2);
    }

    names.push(...parsed.names);
    if (!parsed.cursor || parsed.cursor === cursor) break;
    cursor = parsed.cursor;
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
