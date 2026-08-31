import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_ENV_CONTRACT,
  WEB_ENV_CONTRACT,
} from "../packages/config/src/env-contract.js";

/**
 * Terraform cannot import the environment contract, so nothing but a test
 * keeps `medinstru-app-env` in step with it.
 *
 * The failure this prevents is specific and expensive: a variable added to
 * the contract but not to the env group makes the NEXT production deploy
 * refuse to boot. Render keeps the previous healthy version, so it is not an
 * outage -- but no deploy succeeds until someone works out which of fourteen
 * variables is missing, from a log rather than from a diff.
 *
 * Same shape as scripts/cloudflare-locale-drift.test.mjs, which pins
 * Terraform to LOCALES for the same reason.
 */

const REPO = join(import.meta.dirname, "..");
const read = (relative) => readFileSync(join(REPO, relative), "utf8");

/**
 * Variables Render already supplies by other means, so the group must NOT
 * carry them. Each is here for a different reason, and none is an oversight.
 */
const SUPPLIED_ELSEWHERE = new Set([
  // Render injects it, and render.yaml declares it on the service.
  "PORT",
  // Wired from the managed Postgres via `fromDatabase`.
  "DATABASE_URL",
  // A real secret, set by hand on the service (`sync: false`). It must not
  // enter this repository, which is exactly why it is not a Terraform value.
  "JWT_SECRET",
  // NEXT_PUBLIC_* must ALSO reach the Docker build as build args, so they
  // stay on the services where render.yaml documents them.
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_BLOB_BASE_URL",
  // Carried by render_env_group.cache when the cache exists, and by this
  // group only when it does not -- defining it in both would leave
  // precedence to Render's undocumented ordering between groups.
  "REDIS_URL",
]);

test("the Terraform env group carries every contract variable", () => {
  const main = read("infra/terraform/render/main.tf");
  const group = main.slice(main.indexOf('resource "render_env_group" "app_env"'));

  const required = [...API_ENV_CONTRACT, ...WEB_ENV_CONTRACT]
    .map((rule) => rule.name)
    .filter((name) => !SUPPLIED_ELSEWHERE.has(name));

  const missing = [...new Set(required)].filter(
    (name) => !new RegExp(`^\\s*${name}\\s*=`, "m").test(group),
  );

  assert.deepEqual(
    missing,
    [],
    "add these to render_env_group.app_env, or the next deploy refuses to boot",
  );
});

test("every variable the group carries is one the contract knows", () => {
  // The other direction. A variable in the group that no app reads is dead
  // configuration -- harmless at runtime, but it accumulates, and each one
  // makes the next reader wonder what depends on it.
  const main = read("infra/terraform/render/main.tf");
  const group = main.slice(
    main.indexOf('resource "render_env_group" "app_env"'),
    main.indexOf('resource "render_env_group_link" "app_env"'),
  );

  const known = new Set(
    [...API_ENV_CONTRACT, ...WEB_ENV_CONTRACT].map((rule) => rule.name),
  );
  const declared = [...group.matchAll(/^\s{6}([A-Z][A-Z0-9_]*)\s*=/gm)].map(
    (m) => m[1],
  );

  for (const name of declared) {
    assert.ok(known.has(name), `${name} is in the env group but in no contract`);
  }
});

test("no real secret is committed as a Terraform default", () => {
  // Every secret-bearing variable defaults to EMPTY and is supplied through
  // TF_VAR_ at apply time. A default with a value here would put a
  // credential in git history permanently, readable by every CI job -- the
  // same rule packages/config follows by storing only variable NAMES.
  const variables = read("infra/terraform/render/variables.tf");
  const secretBearing = [
    "inquiry_ip_hash_secret",
    "sourcemap_signing_key",
    "blob_access_key_id",
    "blob_secret_access_key",
    "whatsapp_access_token",
  ];

  for (const name of secretBearing) {
    const block = variables.slice(variables.indexOf(`variable "${name}"`));
    const declaration = block.slice(0, block.indexOf("\n}"));
    assert.match(
      declaration,
      /default\s*=\s*""/,
      `${name} must default to empty; supply it through TF_VAR_${name}`,
    );
    assert.match(
      declaration,
      /sensitive\s*=\s*true/,
      `${name} must be marked sensitive so Terraform never prints it`,
    );
  }
});
