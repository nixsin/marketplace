/**
 * The API's port is one number, declared in several files that cannot import
 * each other.
 *
 * `main.ts` falls back to it when PORT is unset, both Dockerfile stages
 * EXPOSE it, and the startup contract offers it as the dev value. Nothing
 * makes those agree on its own, and they drifted: the fallback was 3000
 * while the image exposed 4000.
 *
 * That is not cosmetic. On 2026-09-04 the API service stopped receiving
 * PORT, Nest bound 3000, Render scanned for a port nothing was listening on,
 * and the deploy failed with "no open ports detected" -- a message naming
 * neither PORT nor the port it looked for. Production only kept serving
 * because the previous instance stayed up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_DEFAULT_PORT } from "../packages/config/src/dev-defaults.js";
import { CONTRACTS } from "../packages/config/src/env-contract.js";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const dockerfile = read("apps/api/Dockerfile");
// Comments and string literals are blanked before anything is matched. This
// file asserts what main.ts DOES, and a sentence in a comment mentioning the
// expression would otherwise satisfy the check while the real `app.listen`
// call had stopped using it.
const main = read("apps/api/src/main.ts")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');

test("every EXPOSE in the API image is the shared default port", () => {
  // Both stages, not just prod: docker-compose maps the dev stage's port for
  // the local stack, and docker-smoke boots it.
  // EVERY `EXPOSE`, matched loosely and then validated -- not just the ones
  // that already look like a port. Matching `^EXPOSE\s+(\d+)` instead would
  // skip `EXPOSE ${PORT}` silently, so deleting a stage's port or making it
  // indirect would leave the other stage satisfying the test alone.
  // Case-insensitive and indentation-tolerant, because Dockerfile
  // instructions are both. `/^EXPOSE/` would miss `expose 3000` entirely, so
  // a conflicting port could sit alongside the two matched ones and still
  // leave the count at two.
  const exposed = [...dockerfile.matchAll(/^[ \t]*EXPOSE[ \t]+(.+)$/gim)].map(
    (m) => m[1].trim(),
  );

  // Both stages: docker-compose maps the dev stage's port for the local
  // stack, and the prod stage is what Render scans.
  assert.equal(
    exposed.length,
    2,
    `expected one EXPOSE per stage (dev, prod), found ${exposed.length}: ${exposed.join(", ")}`,
  );

  for (const value of exposed) {
    assert.match(
      value,
      /^\d+$/,
      `EXPOSE ${value} is not a literal port — this test cannot verify it, ` +
        `and Render scans a number rather than a variable.`,
    );
    assert.equal(
      Number(value),
      API_DEFAULT_PORT,
      `EXPOSE ${value} does not match API_DEFAULT_PORT (${API_DEFAULT_PORT}). ` +
        `A container that loses PORT binds one and Render scans the other.`,
    );
  }
});

test("main.ts falls back to the shared constant, not a literal", () => {
  // The ARGUMENT to app.listen, not merely the expression appearing
  // somewhere in the file. Searching the whole source would accept an unused
  // `const p = process.env.PORT ?? API_DEFAULT_PORT` sitting beside a real
  // `app.listen(3000)` — the exact drift this test exists to prevent, and
  // the reason a positive plus a negative regex is not enough.
  const call = /app\.listen\(([^)]*)\)/.exec(main);
  assert.ok(call, "no app.listen(...) call found in main.ts");

  assert.equal(
    call[1].trim(),
    "process.env.PORT ?? API_DEFAULT_PORT",
    `app.listen receives \`${call[1].trim()}\`. It must read API_DEFAULT_PORT, ` +
      `shared with the Dockerfile's EXPOSE — a literal here is what drifted.`,
  );
});

test("the contract offers the same port as its dev value", () => {
  // A developer copying .env.example gets a value that matches what the code
  // would have chosen anyway, so the two can never disagree quietly.
  const rule = CONTRACTS.api.find((r) => r.name === "PORT");
  assert.ok(rule, "PORT is no longer in the API contract");
  assert.equal(rule.devValue, String(API_DEFAULT_PORT));
});
