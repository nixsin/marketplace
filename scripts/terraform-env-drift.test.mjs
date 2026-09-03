/**
 * Every variable the contract declares must be delivered to Render.
 *
 * Terraform cannot import the contract — it is HCL — so a test is what keeps
 * the two in step, the same mechanism that pins ci.yml and the Cloudflare
 * locale list.
 *
 * The failure this prevents is specific and has already happened once: the
 * `env_vars` blocks on both web services sit under `ignore_changes = all`,
 * so they read as delivery and applied nothing. A variable can be added to
 * the contract, required at boot, and reach production as undefined — with
 * every check green, because nothing compares the two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACTS } from "../packages/config/src/env-contract.js";

const main = readFileSync(
  fileURLToPath(new URL("../infra/terraform/render/main.tf", import.meta.url)),
  "utf8",
);

/**
 * Variable names inside every `render_env_group` block, by group.
 *
 * A brace-depth scan rather than a regex over the whole file: `env_vars`
 * appears in the service resources too, and counting those would report
 * variables as delivered when they sit under `ignore_changes = all` and are
 * applied never — the exact confusion this test exists to end.
 */
function envGroups(source) {
  const groups = {};
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const header = /^resource "render_env_group" "(\w+)"/.exec(lines[i]);
    if (!header) continue;

    let depth = 0;
    let inVars = false;
    const names = [];

    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;

      if (/^\s*env_vars\s*=\s*\{/.test(line)) inVars = true;
      else if (inVars) {
        const m = /^\s{4}([A-Z][A-Z0-9_]*)\s*=/.exec(line);
        if (m) names.push(m[1]);
      }
      if (depth === 0 && j > i) break;
    }
    groups[header[1]] = names;
  }
  return groups;
}

test("every API variable is delivered by an env group", () => {
  const groups = envGroups(main);
  const delivered = new Set([...(groups.api ?? []), ...(groups.cache ?? [])]);

  const wanted = new Set(CONTRACTS.api.map((r) => r.name));

  const missing = [...wanted].filter((name) => !delivered.has(name));
  assert.deepEqual(
    missing,
    [],
    `the API contract requires these and Terraform creates none of them: ${missing.join(", ")}`,
  );

  // BOTH DIRECTIONS. Checking only what is missing let a variable removed
  // from the contract keep being delivered forever — a value production
  // still receives that nothing declares or validates any more.
  const unexpected = [...delivered].filter((name) => !wanted.has(name));
  assert.deepEqual(
    unexpected,
    [],
    `delivered to the API but no longer in the contract: ${unexpected.join(", ")}`,
  );
});

test("every web variable is delivered by an env group", () => {
  const groups = envGroups(main);
  const delivered = new Set(groups.web ?? []);

  const wanted = new Set(CONTRACTS.web.map((r) => r.name));

  const missing = [...wanted].filter((name) => !delivered.has(name));
  assert.deepEqual(missing, [], `undelivered: ${missing.join(", ")}`);

  const unexpected = [...delivered].filter((name) => !wanted.has(name));
  assert.deepEqual(
    unexpected,
    [],
    `delivered to the web app but no longer in the contract: ${unexpected.join(", ")}`,
  );
});

test("the web group carries no secret", () => {
  // Render turns a group's variables into Docker build arguments, and
  // NEXT_PUBLIC_* is inlined into the client bundle — so a secret here would
  // be shipped to every visitor.
  //
  // SOURCEMAP_SIGNING_KEY is the deliberate exception and is safe for one
  // reason: apps/web/Dockerfile declares no ARG for it, so it stays a
  // runtime value and never enters the image.
  const groups = envGroups(main);

  // EITHER contract's secrets. Checking only the web list missed an API
  // secret pasted into the web group — and a secret is a secret whichever
  // app declares it, while the build argument reaches every visitor either
  // way.
  const secrets = new Set(
    Object.values(CONTRACTS)
      .flat()
      .filter((r) => r.secret)
      .map((r) => r.name),
  );

  const shipped = (groups.web ?? []).filter(
    (name) => secrets.has(name) && name !== "SOURCEMAP_SIGNING_KEY",
  );
  assert.deepEqual(shipped, [], `secret in the web group: ${shipped.join(", ")}`);

  const dockerfile = readFileSync(
    fileURLToPath(new URL("../apps/web/Dockerfile", import.meta.url)),
    "utf8",
  );
  assert.ok(
    !/^ARG\s+SOURCEMAP_SIGNING_KEY/m.test(dockerfile),
    "SOURCEMAP_SIGNING_KEY became a build ARG — it would be baked into the image",
  );
});

test("no secret value is written into the Terraform source", () => {
  // Generated secrets come from random_password and supplied ones from
  // TF_VAR_*. A literal here would be committed, and a committed credential
  // stays in git history.
  for (const rule of CONTRACTS.api.filter((r) => r.secret)) {
    const assignment = new RegExp(
      `${rule.name}\\s*=\\s*\\{\\s*value\\s*=\\s*"[^"]+"`,
    );
    assert.ok(
      !assignment.test(main),
      `${rule.name} has a literal value in main.tf — use a variable or random_password`,
    );
  }
});

test("the services declare no env_vars of their own", () => {
  // They carry `ignore_changes = all`, so anything there is applied never.
  // Leaving such a block in place is worse than leaving it out: it reads as
  // delivery, and that is how 11 variables reached production undefined.
  for (const service of ["api", "web"]) {
    const start = main.indexOf(`resource "render_web_service" "${service}"`);
    assert.notEqual(start, -1, `${service} service not found`);

    const next = main.indexOf("\nresource ", start + 1);
    const body = main.slice(start, next === -1 ? undefined : next);

    assert.ok(
      !/^\s*env_vars\s*=/m.test(body),
      `render_web_service.${service} declares env_vars, which ignore_changes makes inert`,
    );
  }
});

test("JWT_SECRET is supplied, not generated", () => {
  // It already exists in production. Regenerating it would invalidate every
  // live session, so it must stay a variable rather than a random_password.
  assert.match(main, /JWT_SECRET\s*=\s*\{\s*value\s*=\s*var\.jwt_secret/);
  assert.ok(
    !/random_password"\s+"jwt/.test(main),
    "JWT_SECRET must not be generated — it would log every user out",
  );
});
