/**
 * Two kinds of test here, and both are needed:
 *
 *   1. the real ci.yml matches the contract right now
 *   2. each rejection branch fires on a fixture that should be rejected
 *
 * (2) exists because (1) alone only ever sees a valid file, so a check that
 * silently stopped working would keep passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  envBlock,
  jobSource,
  jobsAssigningDatabaseUrl,
  unreadableSpellings,
  workflowEnv,
  workflowEnvBlockCount,
} from "./lib/ci-env-drift.mjs";
import {
  DEV_API_URL,
  DEV_DATABASE_URL,
  DEV_POSTGRES_DB,
  DEV_POSTGRES_PASSWORD,
  DEV_POSTGRES_USER,
} from "../packages/config/src/dev-defaults.js";

const source = readFileSync(
  fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

const SECRET = /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/;

// ---------------------------------------------------------------------
// The real ci.yml
// ---------------------------------------------------------------------

test("the workflow-level Postgres account matches the contract", () => {
  const env = workflowEnv(source);
  assert.equal(env.POSTGRES_USER, DEV_POSTGRES_USER);
  assert.equal(env.POSTGRES_PASSWORD, DEV_POSTGRES_PASSWORD);
  assert.equal(env.POSTGRES_DB, DEV_POSTGRES_DB);
});

test("each job needing a database URL owns one, equal to the contract's", () => {
  for (const job of ["test-e2e-web", "load-test"]) {
    const env = envBlock(jobSource(source, job));
    assert.ok(env, `${job} has no job-level env block`);
    assert.equal(env.DATABASE_URL, DEV_DATABASE_URL, `${job}'s URL`);
  }
  assert.equal(
    envBlock(jobSource(source, "test-e2e-web")).NEXT_PUBLIC_API_URL,
    DEV_API_URL,
  );
});

test("test-api-e2e has no DATABASE_URL, at any level", () => {
  // THE ONE THAT MATTERS. That suite loads apps/api/.env.test, dotenv never
  // overwrites an already-set value, and its beforeEach TRUNCATEs every
  // table — so any DATABASE_URL reaching this job wipes the dev database.
  // Checked at the workflow level too, because hoisting it there is the
  // natural tidy-up and exactly the wrong move.
  assert.ok(!("DATABASE_URL" in workflowEnv(source)));

  // The job must EXIST first. `jobSource` returns null when the job is
  // renamed or removed, and `!/regex/.test(null)` tests the string "null",
  // finds no match, and passes — so the guard would silently stop guarding
  // at the exact moment someone restructured the file.
  const job = jobSource(source, "test-api-e2e");
  assert.ok(
    job,
    "test-api-e2e not found — this guard protects it, so its absence is a failure, not a pass",
  );
  assert.ok(!/^\s+DATABASE_URL:/m.test(job));
});

test("a production database URL appears in migrate only", () => {
  // test-e2e-web and load-test run migrations and seeds, so a secret URL
  // there is a destructive write to the real database.
  for (const job of jobsAssigningDatabaseUrl(source)) {
    if (job === "migrate") continue;
    for (const m of jobSource(source, job).matchAll(
      /^\s+DATABASE_URL:\s*(.+)$/gm,
    )) {
      assert.ok(!SECRET.test(m[1].trim()), `${job} uses a secret URL`);
    }
  }
});

test("every database and API URL in the file is one we recognise", () => {
  for (const m of source.matchAll(/^\s+DATABASE_URL:\s*(.+)$/gm)) {
    const url = m[1].trim();
    const ok =
      url === DEV_DATABASE_URL ||
      url === "${{ env.DATABASE_URL }}" ||
      SECRET.test(url);
    assert.ok(ok, `unrecognised DATABASE_URL: ${url}`);
  }
  for (const m of source.matchAll(/^\s+NEXT_PUBLIC_API_URL:\s*(.+)$/gm)) {
    const url = m[1].trim();
    assert.ok(
      url === DEV_API_URL || url === "${{ env.NEXT_PUBLIC_API_URL }}",
      `unrecognised NEXT_PUBLIC_API_URL: ${url}`,
    );
  }
});

test("every Postgres assignment is the shared literal or a reference to it", () => {
  // EVERY assignment, not just the ones already correct — a filter keyed on
  // the expected value skips a wrong one entirely, and a service block can
  // override the inherited workflow value.
  const expected = {
    POSTGRES_USER: DEV_POSTGRES_USER,
    POSTGRES_PASSWORD: DEV_POSTGRES_PASSWORD,
    POSTGRES_DB: DEV_POSTGRES_DB,
  };

  const literals = [];
  for (const m of source.matchAll(
    /^\s+(POSTGRES_(?:USER|PASSWORD|DB)):\s*(.+)$/gm,
  )) {
    const [line, name, raw] = [m[0].trim(), m[1], m[2].trim()];
    // Same-name: `POSTGRES_DB: ${{ env.POSTGRES_USER }}` is a real mistake.
    if (raw === `\${{ env.${name} }}`) continue;
    assert.equal(raw, expected[name], `${line} — not the contract's value`);
    literals.push(line);
  }
  assert.equal(literals.length, 3, `declared ${literals.length} times`);

  for (const [name, value] of Object.entries(expected)) {
    assert.equal(workflowEnv(source)[name], value);
  }
});

test("ci.yml uses only the YAML spelling these checks can read", () => {
  assert.deepEqual(unreadableSpellings(source), []);
});

test("there is exactly one workflow-level env block", () => {
  // workflowEnv reads the FIRST one, so a second added at the bottom of the
  // header is invisible to it — including to the assertion that no
  // DATABASE_URL sits at workflow level, where it would reach test-api-e2e.
  assert.equal(workflowEnvBlockCount(source), 1);
});

// ---------------------------------------------------------------------
// The rejection branches, against fixtures
// ---------------------------------------------------------------------

test("unreadable spellings are each rejected", () => {
  const cases = [
    ['  "DATABASE_URL": postgresql://x/y', "quoted key"],
    ["  'DATABASE_URL': postgresql://x/y", "quoted key"],
    ["  DATABASE_URL : postgresql://x/y", "space before colon"],
    ["    env: *database_env", "YAML anchor or alias"],
    ["    env: &database_env", "YAML anchor or alias"],
    ["  DATABASE_URL: *shared_url", "YAML anchor or alias"],
    ["    env: { DATABASE_URL: postgresql://x/y }", "inline map"],
    ["    foo: { POSTGRES_USER: postgres }", "inline map"],
  ];

  for (const [line, reason] of cases) {
    const found = unreadableSpellings(`name: CI\n${line}\n`);
    assert.equal(found.length, 1, `not rejected: ${line}`);
    assert.match(found[0], new RegExp(reason), `wrong reason for: ${line}`);
  }
});

test("ordinary lines are not rejected", () => {
  // The guard fails a required check, so a false positive blocks every PR.
  // `${{ ... }}` is the one that matters: it contains braces and is not a
  // flow map.
  const fine = [
    "  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/db",
    "          POSTGRES_USER: ${{ env.POSTGRES_USER }}",
    "          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}",
    "    env:",
    '      --health-cmd "pg_isready -U $POSTGRES_USER"',
  ];
  for (const line of fine) {
    assert.deepEqual(
      unreadableSpellings(`name: CI\n${line}\n`),
      [],
      `false positive: ${line}`,
    );
  }
});

test("workflowEnv reads only the column-0 block", () => {
  // A nested `env:` — a workflow_dispatch input, for instance — must not be
  // mistaken for the workflow environment.
  const nested = [
    "name: CI",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      env:",
    "        DATABASE_URL: postgresql://nested/db",
    "env:",
    "  POSTGRES_USER: postgres",
    "",
    "jobs:",
    "  build:",
  ].join("\n");

  const env = workflowEnv(nested);
  assert.equal(env.POSTGRES_USER, "postgres");
  assert.ok(!("DATABASE_URL" in env), "read a nested block");

  // Absent is empty, not a throw.
  assert.deepEqual(workflowEnv("name: CI\n\njobs:\n  build:\n"), {});
});

test("jobSource and envBlock are scoped to the job asked for", () => {
  // The bug this replaced: a file-wide search for a four-space `env:`
  // returned the first job's block for every job, so a per-job loop tested
  // one job twice.
  const two = [
    "jobs:",
    "  first:",
    "    env:",
    "      DATABASE_URL: postgresql://first/db",
    "    steps: []",
    "  second:",
    "    env:",
    "      DATABASE_URL: postgresql://second/db",
    "    steps: []",
  ].join("\n");

  assert.equal(
    envBlock(jobSource(two, "first")).DATABASE_URL,
    "postgresql://first/db",
  );
  assert.equal(
    envBlock(jobSource(two, "second")).DATABASE_URL,
    "postgresql://second/db",
  );
  assert.equal(jobSource(two, "absent"), null);
  assert.equal(envBlock(jobSource(two, "absent")), null);
});

test("jobsAssigningDatabaseUrl attributes each line to its own job", () => {
  const src = [
    "jobs:",
    "  alpha:",
    "    env:",
    "      DATABASE_URL: postgresql://a/db",
    "  beta:",
    "    steps: []",
    "  gamma:",
    "    steps:",
    "      - env:",
    "          DATABASE_URL: ${{ secrets.PROD }}",
  ].join("\n");

  assert.deepEqual(jobsAssigningDatabaseUrl(src).sort(), ["alpha", "gamma"]);
});

test("a missing job is a failure, not a silent pass", () => {
  // jobSource returns null, and `!/x/.test(null)` passes because it tests
  // the string "null". Anything protecting a job by name has to assert the
  // job is there.
  assert.equal(jobSource("jobs:\n  other:\n", "test-api-e2e"), null);
  assert.ok(!/^\s+DATABASE_URL:/m.test(null), "the trap this guards against");
});

test("an escaped quoted key is rejected", () => {
  // YAML resolves "\u0044ATABASE_URL" to DATABASE_URL, which the exact-name
  // scan cannot see.
  const escaped = String.raw`  "\u0044ATABASE_URL": postgresql://x/y`;
  const found = unreadableSpellings(`name: CI\n${escaped}\n`);
  assert.equal(found.length, 1, `not rejected: ${escaped}`);
  assert.match(found[0], /escaped key/);

  // The embedded JSON heredoc uses quoted keys with no escapes, and must
  // keep passing.
  assert.deepEqual(
    unreadableSpellings('name: CI\n            "path_filter": {\n'),
    [],
  );
});

test("envBlock reads the level it was asked for", () => {
  // A service container's env sits above the job-level one in some layouts.
  // Taking the first `env:` meant a job with NO job-level block still
  // passed, reading the service's — while every ${{ env.X }} in that job
  // resolved to nothing.
  const job = [
    "  a-job:",
    "    services:",
    "      postgres:",
    "        env:",
    "          DATABASE_URL: postgresql://service/db",
    "    env:",
    "      DATABASE_URL: postgresql://job/db",
  ].join("\n");

  assert.equal(envBlock(job, 4).DATABASE_URL, "postgresql://job/db");
  assert.equal(envBlock(job, 8).DATABASE_URL, "postgresql://service/db");

  // A job with only a service-level block has no job-level env at all.
  const serviceOnly = [
    "  a-job:",
    "    services:",
    "      postgres:",
    "        env:",
    "          DATABASE_URL: postgresql://service/db",
  ].join("\n");
  assert.equal(envBlock(serviceOnly, 4), null);
});

test("a second workflow-level env block is refused", () => {
  const twoBlocks = [
    "name: CI",
    "env:",
    "  POSTGRES_USER: postgres",
    "env:",
    "  DATABASE_URL: postgresql://sneaky/db",
    "",
    "jobs:",
    "  build:",
  ].join("\n");

  assert.equal(workflowEnvBlockCount(twoBlocks), 2);

  // ...and this is why it matters: the first-block reader cannot see it.
  assert.ok(!("DATABASE_URL" in workflowEnv(twoBlocks)));
});

test("job ids in every plausible form are attributed to themselves", () => {
  // Lowercase-only matching attributed an unrecognised job's lines to the
  // PREVIOUS job — so a secret URL in a job following `migrate` read as
  // migrate's own, the one place a secret is allowed.
  const src = [
    "jobs:",
    "  migrate:",
    "    env:",
    "      DATABASE_URL: ${{ secrets.PROD }}",
    "  Deploy_Web:",
    "    env:",
    "      DATABASE_URL: postgresql://a/db",
    '  "quoted-job":',
    "    env:",
    "      DATABASE_URL: postgresql://b/db",
    "  _internal:",
    "    env:",
    "      DATABASE_URL: postgresql://c/db",
  ].join("\n");

  assert.deepEqual(jobsAssigningDatabaseUrl(src).sort(), [
    "Deploy_Web",
    "_internal",
    "migrate",
    "quoted-job",
  ]);
});

test("explicit-key syntax is rejected", () => {
  // `? DATABASE_URL` / `: value` across two lines — no `NAME:` scan sees it.
  for (const line of ["  ? DATABASE_URL", '  ? "DATABASE_URL"', "    ?  POSTGRES_USER"]) {
    const found = unreadableSpellings(`name: CI\n${line}\n`);
    assert.equal(found.length, 1, `not rejected: ${line}`);
    assert.match(found[0], /explicit key/);
  }
});
