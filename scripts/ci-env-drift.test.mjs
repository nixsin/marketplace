/**
 * Pins ci.yml's environment values to the contract.
 *
 * ci.yml cannot import JavaScript, so it declares these values literally. A
 * test is the only thing that keeps the two in step — the same approach
 * cloudflare-locale-drift.test.mjs uses to pin Terraform to LOCALES.
 *
 * Drift here is silent in the worst way: CI keeps passing against a database
 * URL or account the rest of the repo no longer uses, so the jobs test a
 * configuration nobody runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEV_API_URL,
  DEV_DATABASE_URL,
  DEV_POSTGRES_DB,
  DEV_POSTGRES_PASSWORD,
  DEV_POSTGRES_USER,
} from "../packages/config/src/dev-defaults.js";

const CI = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const source = readFileSync(CI, "utf8");

/** Values under a `key:` block, by simple indentation scan. */
function blockValues(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;

  const indent = header.match(/^\s*/)[0].length + 2;
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) < indent) break;
    const m = /^\s*([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) break;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

test("the workflow-level Postgres account matches the contract", () => {
  const env = blockValues(source, "env:");
  assert.ok(env, "ci.yml has no workflow-level env block");

  assert.equal(env.POSTGRES_USER, DEV_POSTGRES_USER);
  assert.equal(env.POSTGRES_PASSWORD, DEV_POSTGRES_PASSWORD);
  assert.equal(env.POSTGRES_DB, DEV_POSTGRES_DB);
});

test("the jobs that need a database URL use the contract's", () => {
  for (const job of ["test-e2e-web", "load-test"]) {
    const env = blockValues(source, "    env:");
    assert.ok(env, `${job} has no job-level env block`);
  }

  // Every literal database URL in the file is either the contract's dev one
  // or the production secret. A third value means someone typed one.
  const urls = [...source.matchAll(/^\s+DATABASE_URL:\s*(.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  assert.ok(urls.length > 0, "no DATABASE_URL found — did the keys move?");

  for (const url of urls) {
    const ok =
      url === DEV_DATABASE_URL ||
      url === "${{ env.DATABASE_URL }}" ||
      url.includes("secrets.");
    assert.ok(ok, `unrecognised DATABASE_URL in ci.yml: ${url}`);
  }
});

test("the web app's API URL matches the contract", () => {
  const urls = [...source.matchAll(/^\s+NEXT_PUBLIC_API_URL:\s*(.+)$/gm)].map(
    (m) => m[1].trim(),
  );
  assert.ok(urls.length > 0, "no NEXT_PUBLIC_API_URL found");

  for (const url of urls) {
    assert.ok(
      url === DEV_API_URL || url === "${{ env.NEXT_PUBLIC_API_URL }}",
      `unrecognised NEXT_PUBLIC_API_URL in ci.yml: ${url}`,
    );
  }
});

test("test-api-e2e has no DATABASE_URL, at any level", () => {
  // THE ONE THAT MATTERS. That suite loads apps/api/.env.test, and dotenv
  // never overwrites an already-set value — so any DATABASE_URL reaching this
  // job silently points it at the dev database, whose beforeEach TRUNCATEs
  // every table. It has happened once already.
  //
  // Checked against the workflow level too: putting it there is the natural
  // "tidy-up" someone reaches for, and it is exactly the wrong move.
  assert.ok(
    !("DATABASE_URL" in (blockValues(source, "env:") ?? {})),
    "DATABASE_URL must not be workflow-level — it would reach test-api-e2e",
  );

  const lines = source.split("\n");
  const start = lines.findIndex((l) => l === "  test-api-e2e:");
  assert.notEqual(start, -1, "test-api-e2e job not found");

  const end = lines.findIndex(
    (l, i) => i > start && /^  [a-z][\w-]*:\s*$/.test(l),
  );
  const job = lines.slice(start, end === -1 ? undefined : end).join("\n");

  assert.ok(
    !/^\s+DATABASE_URL:/m.test(job),
    "test-api-e2e declares a DATABASE_URL — its suite would truncate the dev database",
  );
});

test("no Postgres literal survives outside the shared block", () => {
  // The point of the shared block is that these appear once. A new job
  // pasting its own copy is how the count crept to nine before.
  const lines = source.split("\n");
  const declared = lines.filter((l) =>
    /^\s+POSTGRES_(USER|PASSWORD|DB):\s*(postgres|medinstru)\s*$/.test(l),
  );
  assert.equal(
    declared.length,
    3,
    `expected only the 3 workflow-level lines, found ${declared.length}:\n${declared.join("\n")}`,
  );
});
