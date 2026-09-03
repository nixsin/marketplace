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

const SERVICES = {
  "medinstru-api": "srv-da02lnojo6nc73djh9bg",
  "medinstru-web": "srv-da02mt61egvs73fopb00",
};

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error(
    "RENDER_API_KEY is not set. Export it in your own shell — this script\n" +
      "never stores it, and nothing in the repository holds a Render credential.",
  );
  process.exit(2);
}

const services = [];
for (const [name, id] of Object.entries(SERVICES)) {
  const response = await fetch(
    `https://api.render.com/v1/services/${id}/env-vars?limit=100`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );

  if (!response.ok) {
    console.error(
      `Render returned ${response.status} for ${name}. The key needs read ` +
        `access to this service.`,
    );
    process.exit(2);
  }

  // The list endpoint wraps each item; a cursor response nests under envVar.
  const body = await response.json();
  const names = body
    .map((item) => item?.envVar?.key ?? item?.key)
    .filter((key) => typeof key === "string");

  services.push({ service: name, names });
}

const findings = shadowedVariables(services, CONTRACTS);
console.log(formatShadowReport(findings));
process.exit(findings.length === 0 ? 0 : 1);
