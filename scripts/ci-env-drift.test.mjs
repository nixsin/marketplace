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

/** Job names that assign DATABASE_URL anywhere in their body. */
function jobsWithDatabaseUrl() {
  const lines = source.split("\n");
  const out = {};
  let job = null;
  for (const line of lines) {
    const m = /^  ([a-z][\w-]*):\s*$/.exec(line);
    if (m) job = m[1];
    if (job && /^\s+DATABASE_URL:/.test(line)) out[job] = true;
  }
  return out;
}

/**
 * The workflow-level `env:` — required at column 0, not merely the first
 * `env:` before `jobs:`. A `workflow_dispatch` input named `env` is nested
 * and would otherwise be mistaken for it.
 */
function workflowEnv() {
  const lines = source.slice(0, source.indexOf("\njobs:")).split("\n");
  const start = lines.findIndex((l) => l === "env:");
  if (start === -1) return {};
  return envBlock(lines.slice(start).join("\n")) ?? {};
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
    const ok = url === DEV_DATABASE_URL || url === "${{ env.DATABASE_URL }}";
    assert.ok(ok || SECRET.test(url), `unrecognised DATABASE_URL: ${url}`);
  }

  // A SECRET URL IS ALLOWED IN `migrate` ONLY. Accepting one file-wide meant
  // a step in test-e2e-web or load-test could point at production with
  // `${{ secrets.PROD_DATABASE_URL }}` and satisfy every check here — and
  // those jobs run migrations and seeds, so that is a destructive write to
  // the real database.
  const secretsOutsideMigrate = [];
  for (const job of Object.keys(jobsWithDatabaseUrl())) {
    if (job === "migrate") continue;
    const text = jobSource(job) ?? "";
    for (const m of text.matchAll(/^\s+DATABASE_URL:\s*(.+)$/gm)) {
      if (SECRET.test(m[1].trim())) secretsOutsideMigrate.push(`${job}: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(
    secretsOutsideMigrate,
    [],
    `a secret DATABASE_URL outside migrate:\n${secretsOutsideMigrate.join("\n")}`,
  );
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

test("every Postgres assignment is the shared literal or a reference to it", () => {
  // EVERY assignment, not just the ones that already look right. A filter
  // keyed on the expected value skipped `POSTGRES_USER: wrong-user`
  // entirely — the count stayed at three and the test passed while that
  // job's container got a different account. A service block CAN override
  // the inherited workflow value, which is exactly the drift this exists
  // to catch.
  const expected = {
    POSTGRES_USER: DEV_POSTGRES_USER,
    POSTGRES_PASSWORD: DEV_POSTGRES_PASSWORD,
    POSTGRES_DB: DEV_POSTGRES_DB,
  };

  const assignments = [
    ...source.matchAll(/^\s+(POSTGRES_(?:USER|PASSWORD|DB)):\s*(.+)$/gm),
  ].map((m) => ({ line: m[0].trim(), name: m[1], value: m[2].trim() }));

  assert.ok(assignments.length > 0, "no POSTGRES_* assignments found");

  const literals = [];
  for (const { line, name, value } of assignments) {
    // A reference must name the SAME variable: `POSTGRES_DB: ${{ env.POSTGRES_USER }}`
    // is a real mistake this would otherwise wave through.
    if (value === `\${{ env.${name} }}`) continue;

    assert.equal(
      value,
      expected[name],
      `${line} — must be the contract's value or \${{ env.${name} }}`,
    );
    literals.push(line);
  }

  assert.equal(
    literals.length,
    3,
    `the account must be declared exactly once; found ${literals.length} literal lines:\n${literals.join("\n")}`,
  );

  // ...and those three are the workflow-level block, not some job's copy.
  const env = workflowEnv();
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(env[name], value, `${name} is not the workflow-level value`);
  }
});

test("ci.yml uses only the YAML spelling these checks can read", () => {
  // THE HONEST GUARD, and it exists because of what this file is not: a YAML
  // parser. test-ci-scripts runs without `pnpm install` — checkout,
  // setup-node, `node --test` — so no parser is available, and hand-rolling
  // one is the trap that produced the .env-parser bugs this repo already
  // records.
  //
  // GitHub accepts spellings these regexes do not read:
  //
  //   "DATABASE_URL": value        a quoted key
  //   DATABASE_URL : value         a space before the colon
  //   env: { DATABASE_URL: ... }   an inline map
  //
  // Any of them would slip past the scans above — including the one stopping
  // a DATABASE_URL from reaching test-api-e2e, which is a destructive write
  // to the dev database. So rather than pretend to handle them, this fails
  // loudly the moment one appears: the blind spot becomes a red check
  // instead of a silent gap.
  const WATCHED = "(?:DATABASE_URL|NEXT_PUBLIC_API_URL|POSTGRES_(?:USER|PASSWORD|DB))";
  const offenders = [];

  source.split("\n").forEach((line, i) => {
    const at = `line ${i + 1}: ${line.trim()}`;
    if (new RegExp(`^\\s*["']${WATCHED}["']\\s*:`).test(line)) {
      offenders.push(`${at}   (quoted key)`);
    } else if (new RegExp(`^\\s*${WATCHED}\\s+:`).test(line)) {
      offenders.push(`${at}   (space before colon)`);
    } else {
      // `${{ ... }}` is an ACTIONS EXPRESSION, not a YAML flow map, and it
      // contains braces — so it must come out before asking about braces or
      // every legitimate reference reads as an inline map.
      const yamlOnly = line.replace(/\$\{\{[^}]*\}\}/g, "");
      if (
        /^\s*env:\s*\{/.test(yamlOnly) ||
        (yamlOnly.includes("{") && new RegExp(`${WATCHED}\\s*:`).test(yamlOnly))
      ) {
        offenders.push(`${at}   (inline map)`);
      }
    }
  });

  assert.deepEqual(
    offenders,
    [],
    `ci.yml uses a YAML spelling these drift checks cannot parse, so they ` +
      `would silently stop protecting it:\n${offenders.join("\n")}\n\n` +
      `Write it as a plain block key, or teach this file to parse YAML properly.`,
  );
});
