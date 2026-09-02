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

/** The lines of one job, from its key to the next job's. */
function jobSource(name) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const end = lines.findIndex(
    (l, i) => i > start && /^  [a-z][\w-]*:\s*$/.test(l),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/**
 * `NAME: value` pairs under the first `env:` in `text`, at its indentation.
 *
 * Scoped to the text it is given, which is the whole point: an earlier
 * version searched the WHOLE file for a four-space-indented `env:` and so
 * always returned the first job's, making a per-job loop test one job twice.
 */
function envBlock(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*env:\s*$/.test(l));
  if (start === -1) return null;

  const indent = lines[start].search(/\S/) + 2;
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

/** The workflow-level block: the first `env:` at column 0. */
function workflowEnv() {
  const before = source.slice(0, source.indexOf("\njobs:"));
  return envBlock(before) ?? {};
}

test("the workflow-level Postgres account matches the contract", () => {
  const env = workflowEnv();
  assert.equal(env.POSTGRES_USER, DEV_POSTGRES_USER);
  assert.equal(env.POSTGRES_PASSWORD, DEV_POSTGRES_PASSWORD);
  assert.equal(env.POSTGRES_DB, DEV_POSTGRES_DB);
});

test("each job that needs a database URL owns one, equal to the contract's", () => {
  // Per JOB, not a global scan. Either of these could lose its block while
  // `${{ env.DATABASE_URL }}` references stayed behind, and a file-wide
  // search would still pass — the references would resolve to nothing and
  // the job would run against no database at all.
  for (const job of ["test-e2e-web", "load-test"]) {
    const text = jobSource(job);
    assert.ok(text, `${job} not found in ci.yml`);

    const env = envBlock(text);
    assert.ok(env, `${job} has no job-level env block`);
    assert.equal(
      env.DATABASE_URL,
      DEV_DATABASE_URL,
      `${job}'s DATABASE_URL is not the contract's`,
    );
  }

  // test-e2e-web owns the API URL, for the same reason.
  const web = envBlock(jobSource("test-e2e-web"));
  assert.equal(web.NEXT_PUBLIC_API_URL, DEV_API_URL);
});

test("no other database URL is introduced anywhere", () => {
  // The per-job checks above prove the two declarations are right; this
  // proves nobody added a third somewhere else.
  const urls = [...source.matchAll(/^\s+DATABASE_URL:\s*(.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  assert.ok(urls.length > 0, "no DATABASE_URL found — did the keys move?");

  // The production one is matched as a COMPLETE secret expression. A
  // substring test for "secrets." accepted `postgresql://secrets.invalid/db`,
  // which is a literal URL wearing the right word.
  const SECRET = /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/;

  for (const url of urls) {
    const ok =
      url === DEV_DATABASE_URL ||
      url === "${{ env.DATABASE_URL }}" ||
      SECRET.test(url);
    assert.ok(ok, `unrecognised DATABASE_URL in ci.yml: ${url}`);
  }
});

test("the web app's API URL matches the contract everywhere it appears", () => {
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
  // Checked at the workflow level too: hoisting it there is the natural
  // tidy-up, and it is exactly the wrong move.
  assert.ok(
    !("DATABASE_URL" in workflowEnv()),
    "DATABASE_URL must not be workflow-level — it would reach test-api-e2e",
  );

  const job = jobSource("test-api-e2e");
  assert.ok(job, "test-api-e2e not found");
  assert.ok(
    !/^\s+DATABASE_URL:/m.test(job),
    "test-api-e2e declares a DATABASE_URL — its suite would truncate the dev database",
  );
});

test("the Postgres account is declared once, and nowhere else", () => {
  // Values come from the contract, not typed here: hard-coding them meant a
  // changed contract matched zero lines and the test passed while checking
  // nothing.
  const expected = {
    POSTGRES_USER: DEV_POSTGRES_USER,
    POSTGRES_PASSWORD: DEV_POSTGRES_PASSWORD,
    POSTGRES_DB: DEV_POSTGRES_DB,
  };

  const declared = source
    .split("\n")
    .filter((line) => {
      const m = /^\s+(POSTGRES_(?:USER|PASSWORD|DB)):\s*(.+)$/.exec(line);
      return m && m[2].trim() === expected[m[1]];
    });

  assert.equal(
    declared.length,
    3,
    `the account must be declared exactly once; found ${declared.length} literal lines:\n${declared.join("\n")}`,
  );

  // ...and those three are the workflow-level block, not a job's copy.
  const env = workflowEnv();
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(env[name], value, `${name} is not the workflow-level value`);
  }
});
