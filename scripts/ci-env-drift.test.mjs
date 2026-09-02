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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  envBlock,
  jobSource,
  jobsAssigningDatabaseUrl,
  stripComments,
  stripCommentsAndStrings,
  unguardedTruncates,
  unreadableSpellings,
  workflowEnv,
  workflowEnvBlockCount,
} from "./lib/ci-env-drift.mjs";
import { redactUrlCredentials } from "../packages/config/src/env-contract.js";
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

// The migration secret is pinned by NAME. Accepting any secret let an
// accidental `${{ secrets.API_KEY }}` read as a valid production migration
// configuration — a check that says "a secret" when it means "this one".
const MIGRATION_SECRET = /^\$\{\{\s*secrets\.PROD_DATABASE_URL\s*\}\}$/;

/**
 * Is `index` inside the body of a `beforeAll(` / `beforeEach(` call?
 *
 * Balanced-bracket scan from each hook's opening paren. Small and tractable
 * over a region of JavaScript — unlike parsing YAML, which is why the
 * workflow checks stop at declaring what they cannot read.
 *
 * Brackets inside strings, template literals or comments would confuse it;
 * they do not appear between these hooks' parens in this repo's specs, and
 * a miscount fails CLOSED — the containment simply is not found and the
 * test reports it.
 */
/** Every *.e2e-spec.ts under `dir`, including subdirectories. */
function findSpecs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...findSpecs(`${full}/`));
    else if (entry.name.endsWith(".e2e-spec.ts")) out.push(full);
  }
  return out;
}






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
  // That suite loads apps/api/.env.test, and dotenv never overwrites an
  // already-set value — so a DATABASE_URL reaching this job silently
  // redirects it, and its beforeEach TRUNCATEs every table.
  //
  // This check stops that configuration from MERGING. It does not prevent
  // the damage: it runs in test-ci-scripts, concurrently with the job it
  // describes. `assertConnectedToTestDatabase` is the prevention — see the
  // test below.
  //
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

test("migrate uses a production secret, and only migrate does", () => {
  // BOTH DIRECTIONS. The one-way version rejected a secret outside migrate
  // but never checked migrate had one — so pointing the production migration
  // at the dev database, or at ${{ env.DATABASE_URL }}, passed every check
  // here while breaking production migrations.
  const migrate = jobSource(source, "migrate");
  assert.ok(migrate, "the migrate job is gone — production migrations run there");
  const urls = [...migrate.matchAll(/^\s+DATABASE_URL:\s*(.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  assert.ok(urls.length > 0, "migrate declares no DATABASE_URL");
  // REDACTED. The failure these checks exist to catch is a production URL
  // pasted as a literal — so printing the value writes real credentials into
  // a CI log, which is the one place they must never appear.
  assert.ok(
    urls.every((u) => MIGRATION_SECRET.test(u)),
    `migrate must use secrets.PROD_DATABASE_URL; got ${urls.map(redactUrlCredentials).join(", ")}`,
  );

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
    assert.ok(ok, `unrecognised DATABASE_URL: ${redactUrlCredentials(url)}`);
  }
  for (const m of source.matchAll(/^\s+NEXT_PUBLIC_API_URL:\s*(.+)$/gm)) {
    const url = m[1].trim();
    assert.ok(
      url === DEV_API_URL || url === "${{ env.NEXT_PUBLIC_API_URL }}",
      `unrecognised NEXT_PUBLIC_API_URL: ${redactUrlCredentials(url)}`,
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
    assert.equal(
      raw,
      expected[name],
      `${redactUrlCredentials(line)} — not the contract's value`,
    );
    literals.push(line);
  }
  assert.equal(literals.length, 3, `declared ${literals.length} times`);

  for (const [name, value] of Object.entries(expected)) {
    assert.equal(workflowEnv(source)[name], value);
  }
});

test("every postgres service maps all three account variables", () => {
  // The literal count stays at three when a SERVICE mapping is deleted, so
  // a container could silently lose POSTGRES_PASSWORD while every other
  // check here passed.
  const wanted = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"];
  const withService = ["test-api-e2e", "test-e2e-web", "load-test"];

  for (const job of withService) {
    const text = jobSource(source, job);
    assert.ok(text, `${job} not found`);

    const env = envBlock(text, 8);
    assert.ok(env, `${job}'s postgres service has no env block`);

    for (const name of wanted) {
      assert.equal(
        env[name],
        `\${{ env.${name} }}`,
        `${job}'s service must map ${name} to the workflow value`,
      );
    }
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

test("no e2e spec has an unguarded TRUNCATE", () => {
  // The rules live in lib/ci-env-drift.mjs so the fixtures below exercise
  // the real function rather than a helper.
  const dir = fileURLToPath(new URL("../apps/api/test/", import.meta.url));
  const specs = findSpecs(dir);
  assert.ok(specs.length > 0, "no e2e specs found — did they move?");

  for (const spec of specs) {
    const text = readFileSync(spec, "utf8");

    const offsets = unguardedTruncates(text);
    assert.deepEqual(
      offsets,
      [],
      `${spec.slice(dir.length)} truncates without a usable guard call, at ${offsets.join(", ")}`,
    );
  }
});

test("the inline-map and explicit-key rules handle quoting and boundaries", () => {
  // A quoted key inside an inline map evaded both the line-anchored quoted
  // check and the inline-map check, which looked for `NAME:` with no quote
  // between.
  const quotedInline = '    env: { "DATABASE_URL": postgresql://x/y }';
  assert.equal(unreadableSpellings(`name: CI\n${quotedInline}\n`).length, 1);

  // And the explicit-key rule needs a boundary, or an unrelated variable is
  // rejected as if it were a watched one — a false positive here blocks
  // every PR.
  for (const line of ["  ? DATABASE_URL_POOL", '  ? "DATABASE_URL_EXTRA"']) {
    assert.deepEqual(
      unreadableSpellings(`name: CI\n${line}\n`),
      [],
      `false positive: ${line}`,
    );
  }
  for (const line of ["  ? DATABASE_URL", '  ? "DATABASE_URL"']) {
    assert.equal(unreadableSpellings(`name: CI\n${line}\n`).length, 1, line);
  }
});

test("jobSource finds every id jobsAssigningDatabaseUrl reports", () => {
  // The two used the same ids and different lookups: one stripped quotes
  // and returned `quoted-job`, the other searched for the exact line, found
  // nothing, and every caller then ran `.matchAll` on null.
  const src = [
    "jobs:",
    '  "quoted-job":',
    "    env:",
    "      DATABASE_URL: postgresql://q/db",
    "  Upper_Case:",
    "    env:",
    "      DATABASE_URL: postgresql://u/db",
    "  _leading:",
    "    env:",
    "      DATABASE_URL: postgresql://l/db",
  ].join("\n");

  const jobs = jobsAssigningDatabaseUrl(src);
  assert.ok(jobs.length >= 3);
  for (const job of jobs) {
    assert.ok(jobSource(src, job), `jobSource cannot find "${job}"`);
  }
});

// ---------------------------------------------------------------------
// The lexer and scope helpers, directly
// ---------------------------------------------------------------------

test("stripComments blanks comments and keeps offsets", () => {
  const src = 'const a = 1; // TRUNCATE\n/* TRUNCATE */ const b = "TRUNCATE";';
  const out = stripComments(src);

  assert.equal(out.length, src.length, "offsets must stay comparable");
  assert.ok(!/TRUNCATE/.test(out.slice(0, src.indexOf("\n"))), "line comment");
  assert.ok(out.includes('"TRUNCATE"'), "strings are kept — SQL lives in them");
  assert.equal(out.indexOf("const b"), src.indexOf("const b"));
});

test("stripCommentsAndStrings blanks both and keeps offsets", () => {
  const src = 'a(); // guard()\nconst s = "guard()";\nguard();';
  const out = stripCommentsAndStrings(src);

  assert.equal(out.length, src.length);
  assert.equal(
    [...out.matchAll(/guard\(\)/g)].length,
    1,
    "only the real call survives",
  );
  assert.equal(out.indexOf("guard()"), src.lastIndexOf("guard();"));
});



test("stripComments does not mistake comment markers inside strings", () => {
  // A `//` in a URL, or `/*` in SQL, is not a comment. Treating it as one
  // blanks the rest of the line and can hide a TRUNCATE — in the one view
  // that keeps strings specifically so the SQL stays visible.
  const url = 'const u = "https://x/y"; await q(`TRUNCATE TABLE "P"`);';
  const out = stripComments(url);
  assert.match(out, /TRUNCATE/, "the SQL was hidden by a URL's slashes");
  assert.equal(out.length, url.length);

  const sql = 'await q("/* not a comment */ TRUNCATE TABLE t");';
  assert.match(stripComments(sql), /TRUNCATE/);

  // A real comment is still blanked.
  const real = 'a(); // TRUNCATE TABLE t';
  assert.ok(!/TRUNCATE/.test(stripComments(real)));
});











test("a job key with a trailing comment is attributed to itself", () => {
  // Requiring end-of-line after the colon meant such a job's lines went to
  // the PREVIOUS one — and if that was `migrate`, a production secret read
  // as migrate's own.
  const src = [
    "jobs:",
    "  migrate:",
    "    env:",
    "      DATABASE_URL: ${{ secrets.PROD }}",
    "  Deploy_Web: # deployment job",
    "    env:",
    "      DATABASE_URL: ${{ secrets.ALSO_PROD }}",
  ].join("\n");

  assert.deepEqual(jobsAssigningDatabaseUrl(src).sort(), [
    "Deploy_Web",
    "migrate",
  ]);
  assert.ok(jobSource(src, "Deploy_Web"), "jobSource must find it too");
  assert.ok(
    !jobSource(src, "migrate").includes("ALSO_PROD"),
    "migrate's source must stop at the next job",
  );
});














test("a second workflow env block after jobs: is counted", () => {
  // The count read only the header, so an appended column-0 `env:` stayed
  // invisible — while still reaching every job, test-api-e2e included.
  const appended = [
    "name: CI",
    "env:",
    "  POSTGRES_USER: postgres",
    "",
    "jobs:",
    "  build:",
    "    steps: []",
    "env:",
    "  DATABASE_URL: postgresql://sneaky/db",
  ].join("\n");

  assert.equal(workflowEnvBlockCount(appended), 2);
  assert.equal(workflowEnvBlockCount("name: CI\n\njobs:\n  b:\n"), 0);
});

test("an inline-map key matching only by suffix is not flagged", () => {
  // `MY_DATABASE_URL` and `OLD_POSTGRES_USER` are unrelated variables, and a
  // false positive here fails a required check.
  for (const line of [
    "  x: { MY_DATABASE_URL: v }",
    "  x: { OLD_POSTGRES_USER: v }",
  ]) {
    assert.deepEqual(
      unreadableSpellings(`name: CI\n${line}\n`),
      [],
      `false positive: ${line}`,
    );
  }

  assert.equal(
    unreadableSpellings("name: CI\n  x: { DATABASE_URL: v }\n").length,
    1,
  );
});



test("a YAML merge key is refused", () => {
  // `<<: *database_env` pulls in a whole anchored map, assigning variables
  // that appear nowhere in the job's own text — the same hole as an alias.
  for (const line of ["    <<: *database_env", "  <<: *shared"]) {
    const found = unreadableSpellings(`name: CI\n${line}\n`);
    assert.equal(found.length, 1, `not rejected: ${line}`);
    assert.match(found[0], /merge key/);
  }
});



test("every way the guard goes missing by accident is caught", () => {
  // The whole scope of this lint, stated as fixtures. Anything subtler is
  // the runtime guard's job — see the note at the top of the lib section.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const missing = {
    "deleted": `describe('s',()=>{beforeEach(async()=>{${trunc}});});`,
    "after the truncate": `describe('s',()=>{beforeEach(async()=>{${trunc}${guard}});});`,
    "outside any hook": `describe('s',()=>{function h(){${guard}}beforeEach(async()=>{${trunc}});});`,
    "not awaited": `describe('s',()=>{beforeAll(()=>{assertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`,
    "commented out": `describe('s',()=>{beforeAll(async()=>{// ${guard}\n});beforeEach(async()=>{${trunc}});});`,
    "only inside a string": `describe('s',()=>{beforeAll(async()=>{const x='${guard}';});beforeEach(async()=>{${trunc}});});`,
    "a suffixed identifier": `describe('s',()=>{beforeAll(async()=>{await fakeAssertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`,
  };
  for (const [why, src] of Object.entries(missing)) {
    assert.ok(unguardedTruncates(src).length > 0, `accepted a guard ${why}`);
  }

  const present = {
    "awaited in a beforeAll": `describe('s',()=>{beforeAll(async()=>{${guard}});beforeEach(async()=>{${trunc}});});`,
    "returned from a hook": `describe('s',()=>{beforeAll(()=>{return assertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`,
    "with a tagged-template truncate": `describe('s',()=>{beforeAll(async()=>{${guard}});beforeEach(async()=>{await p.$executeRaw\`TRUNCATE TABLE t\`;});});`,
    "no truncate at all": "describe('s',()=>{it('x',()=>{});});",
  };
  for (const [why, src] of Object.entries(present)) {
    assert.deepEqual(unguardedTruncates(src), [], `rejected: ${why}`);
  }
});

test("a return broken by a newline does not count", () => {
  // `return\n  assertConnectedToTestDatabase(p)` returns undefined:
  // automatic semicolon insertion ends the statement at the line break, so
  // the hook never waits for the guard.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";
  const asi = `describe('s',()=>{beforeAll(()=>{return\n  assertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(asi).length, 1);

  const sameLine = `describe('s',()=>{beforeAll(()=>{return assertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`;
  assert.deepEqual(unguardedTruncates(sameLine), []);
});

test("a guard-shaped expression outside a hook does not mask a real one", () => {
  // Only the first match was examined, so a helper containing one made the
  // lint report every truncate while a real guard sat in the hook below.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const both = `describe('s',()=>{const h=()=>{return assertConnectedToTestDatabase(p);};beforeAll(async()=>{${guard}});beforeEach(async()=>{${trunc}});});`;
  assert.deepEqual(unguardedTruncates(both), [], "a real guard must still count");

  // ...and a helper on its own is still not a guard.
  const helperOnly = `describe('s',()=>{const h=()=>{return assertConnectedToTestDatabase(p);};beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(helperOnly).length, 1);
});

test("prose containing TRUNCATE TABLE is not a statement", () => {
  // `code` keeps strings because the SQL lives in one, so prose mentioning
  // the keywords would reject a safe spec — a false positive on a required
  // check. The string has to BEGIN with the statement.
  for (const text of [
    "does not TRUNCATE TABLE users",
    "rejects TRUNCATE ONLY from untrusted callers",
    "documents why we TRUNCATE TABLE between tests",
  ]) {
    assert.deepEqual(
      unguardedTruncates(`describe('s',()=>{it('${text}',()=>{});});`),
      [],
      `false positive: ${text}`,
    );
  }

  // A real one is still reported.
  assert.equal(
    unguardedTruncates(
      "describe('s',()=>{beforeEach(async()=>{await p.$executeRawUnsafe('TRUNCATE TABLE t');});});",
    ).length,
    1,
  );
});
