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
  enclosingExtent,
  hookKindAt,
  stripComments,
  stripCommentsAndStrings,
  unguardedTruncates,
  unlintableConstructs,
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
    urls.every((u) => SECRET.test(u)),
    `migrate must use a secret; got ${urls.map(redactUrlCredentials).join(", ")}`,
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

test("no e2e spec has an unguarded TRUNCATE", () => {
  // The lint's own rules live in lib/ci-env-drift.mjs so the fixtures below
  // exercise the real function. While they were inline here, every fixture
  // tested a helper and the covering rule could have been deleted with all
  // of them still passing.
  const dir = fileURLToPath(new URL("../apps/api/test/", import.meta.url));
  const specs = findSpecs(dir);
  assert.ok(specs.length > 0, "no e2e specs found — did they move?");

  for (const spec of specs) {
    const text = readFileSync(spec, "utf8");

    // Declared limits first, same as the YAML checks do one language over.
    // A bracket inside a regex, or a template nested in an interpolation,
    // breaks the extent scans — so a spec containing one is reported rather
    // than quietly dropped from the lint.
    assert.deepEqual(
      unlintableConstructs(text),
      [],
      `${spec.slice(dir.length)} uses JavaScript these scans cannot read, so the guard lint would stop protecting it`,
    );

    const offsets = unguardedTruncates(text);
    assert.deepEqual(
      offsets,
      [],
      `${spec.slice(dir.length)} truncates without a guard covering it, at ${offsets.join(", ")}`,
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

test("setup-hook containment is lexical", () => {
  const inside = "beforeAll(async () => {\n  guard();\n});";
  assert.ok(hookKindAtTruthy(inside, inside.indexOf("guard()")));

  // After a hook that has already closed — the shape lastIndexOf accepted.
  const after = "beforeAll(() => {});\nfunction stray() { guard(); }";
  assert.ok(!hookKindAtTruthy(after, after.indexOf("guard()")));

  // Nested inside the hook still counts as contained; the comment on the
  // lint says so, and says why proving invocation needs an AST.
  const nested = "beforeEach(() => {\n  function h() { guard(); }\n});";
  assert.ok(hookKindAtTruthy(nested, nested.indexOf("guard()")));
});

test("enclosingExtent finds the innermost describe", () => {
  const src = [
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    truncate();",
    "  });",
    "});",
  ].join("\n");

  const at = src.indexOf("truncate()");
  const scope = enclosingExtent(src, at, /(?<![\w$.])describe\s*\(/g);
  assert.ok(scope, "no enclosing describe found");
  assert.ok(scope.start > src.indexOf("outer"), "must be the inner one");

  // Nothing enclosing is null, not a throw.
  assert.equal(enclosingExtent("truncate();", 0, /(?<![\w$.])describe\s*\(/g), null);
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

test("a guard covers only what its own scope contains", () => {
  // Outer covers nested; a child covers nothing outside itself. Asking the
  // other way round accepted a child's guard for a parent truncate and
  // rejected an outer guard for a nested one.
  const outerGuard = [
    "describe('outer', () => {",
    "  beforeAll(async () => { await assertConnectedToTestDatabase(p); });",
    "  describe('inner', () => {",
    "    beforeEach(async () => { await p.$executeRawUnsafe('TRUNCATE TABLE t'); });",
    "  });",
    "});",
  ].join("\n");

  const at = outerGuard.indexOf("TRUNCATE");
  const g = outerGuard.indexOf("assertConnectedToTestDatabase");
  const gScope = enclosingExtent(outerGuard, g, /(?<![\w$.])describe\s*\(/g);
  assert.ok(
    gScope && at > gScope.start && at < gScope.end,
    "an outer guard must cover a nested truncate",
  );

  const childGuard = [
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    beforeAll(async () => { await assertConnectedToTestDatabase(p); });",
    "  });",
    "  beforeEach(async () => { await p.$executeRawUnsafe('TRUNCATE TABLE t'); });",
    "});",
  ].join("\n");

  const at2 = childGuard.indexOf("TRUNCATE");
  const g2 = childGuard.indexOf("assertConnectedToTestDatabase");
  const gScope2 = enclosingExtent(childGuard, g2, /(?<![\w$.])describe\s*\(/g);
  assert.ok(
    gScope2 && !(at2 > gScope2.start && at2 < gScope2.end),
    "a child guard must not cover a truncate in the parent",
  );
});

test("a beforeEach guard does not cover a beforeAll TRUNCATE", () => {
  // Jest runs every beforeAll before any beforeEach, so file order is not
  // execution order. This pairing is checkable without a lifecycle model.
  const unsafe = [
    "describe('s', () => {",
    "  beforeEach(async () => { await assertConnectedToTestDatabase(p); });",
    "  beforeAll(async () => { await p.$executeRawUnsafe('TRUNCATE TABLE t'); });",
    "});",
  ].join("\n");

  const at = unsafe.indexOf("TRUNCATE");
  const g = unsafe.indexOf("assertConnectedToTestDatabase");
  assert.equal(hookKindAt(unsafe, at), "All");
  assert.equal(hookKindAt(unsafe, g), "Each");

  // The safe direction still reads as safe.
  const safe = unsafe
    .replace("beforeEach(async () => { await assertConnected", "beforeAll(async () => { await assertConnected");
  assert.equal(hookKindAt(safe, safe.indexOf("assertConnectedToTestDatabase")), "All");
});

test("hook and describe recognition requires an identifier boundary", () => {
  // `notbeforeAll(` and `customdescribe(` are ordinary helpers, not Jest.
  const fake = "notbeforeAll(() => { guard(); });";
  assert.ok(!hookKindAtTruthy(fake, fake.indexOf("guard()")));

  const fakeDescribe = "customdescribe('x', () => { truncate(); });";
  assert.equal(
    enclosingExtent(fakeDescribe, fakeDescribe.indexOf("truncate()"), /(?<![\w$.])describe\s*\(/g),
    null,
  );

  // A method call is not the global either.
  const method = "suite.describe('x', () => { truncate(); });";
  assert.equal(
    enclosingExtent(method, method.indexOf("truncate()"), /(?<![\w$.])describe\s*\(/g),
    null,
  );

  // The real ones still match.
  const real = "beforeAll(() => { guard(); });";
  assert.ok(hookKindAtTruthy(real, real.indexOf("guard()")));
});

test("only SQL-looking truncates demand a guard", () => {
  // A test title or an expected error message containing the word would
  // otherwise block an unrelated change.
  const inert = [
    "it('rejects TRUNCATE in user input', () => {});",
    "expect(e.message).toBe('TRUNCATE is not permitted');",
  ].join("\n");
  assert.ok(!/truncate\s+(?:table\b|only\b|")/i.test(inert));

  // Real statements still match, in the spellings this repo uses.
  for (const sql of [
    'TRUNCATE TABLE "Product"',
    "truncate table product",
    'TRUNCATE "Product", "License"',
    "TRUNCATE ONLY t",
  ]) {
    assert.match(sql, /truncate\s+(?:table\b|only\b|")/i, sql);
  }
});

/** `hookKindAt` as a boolean — the containment question on its own. */
function hookKindAtTruthy(text, index) {
  return hookKindAt(text, index) !== null;
}

test("unguardedTruncates rejects every unsafe arrangement", () => {
  // These call the REAL covering function. The previous fixtures asserted
  // helper classifications, so the covering rule itself could have been
  // deleted with all of them still passing.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const unsafe = {
    "no guard at all": `describe('s',()=>{beforeEach(async()=>{${trunc}});});`,

    "guard after the truncate": `describe('s',()=>{beforeEach(async()=>{${trunc}${guard}});});`,

    "guard outside any hook": `describe('s',()=>{function h(){${guard}}beforeEach(async()=>{${trunc}});});`,

    "beforeEach guard, beforeAll truncate":
      `describe('s',()=>{beforeEach(async()=>{${guard}});beforeAll(async()=>{${trunc}});});`,

    "guard in a child describe, truncate in the parent":
      `describe('o',()=>{describe('i',()=>{beforeAll(async()=>{${guard}});});beforeEach(async()=>{${trunc}});});`,

    "guard name is a suffix of another identifier":
      `describe('s',()=>{beforeAll(async()=>{await fakeAssertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`,

    "guard commented out": `describe('s',()=>{beforeAll(async()=>{// ${guard}\n});beforeEach(async()=>{${trunc}});});`,

    "guard only in a string": `describe('s',()=>{beforeAll(async()=>{const x='${guard}';});beforeEach(async()=>{${trunc}});});`,
  };

  for (const [why, src] of Object.entries(unsafe)) {
    assert.equal(unguardedTruncates(src).length, 1, `accepted: ${why}`);
  }
});

test("unguardedTruncates accepts every safe arrangement", () => {
  // A false positive blocks a required check, so both directions matter.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const safe = {
    "guard and truncate in the same beforeEach":
      `describe('s',()=>{beforeEach(async()=>{${guard}${trunc}});});`,

    "beforeAll guard, beforeEach truncate":
      `describe('s',()=>{beforeAll(async()=>{${guard}});beforeEach(async()=>{${trunc}});});`,

    "outer guard covers a nested truncate":
      `describe('o',()=>{beforeAll(async()=>{${guard}});describe('i',()=>{beforeEach(async()=>{${trunc}});});});`,

    "guard inside describe.each still scopes":
      `describe.each([1])('o',()=>{beforeAll(async()=>{${guard}});beforeEach(async()=>{${trunc}});});`,

    "no truncate at all": `describe('s',()=>{it('x',()=>{});});`,

    "the word truncate in a title, not SQL":
      `describe('s',()=>{it('rejects TRUNCATE in input',()=>{});});`,
  };

  for (const [why, src] of Object.entries(safe)) {
    assert.deepEqual(unguardedTruncates(src), [], `rejected: ${why}`);
  }
});

test("unquoted TRUNCATE targets are detected", () => {
  // `TRUNCATE users` and `TRUNCATE public.users` are valid Postgres and were
  // skipped entirely, so a spec using either could lose its guard unnoticed.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE users');";
  const schema = "await p.$executeRawUnsafe('TRUNCATE public.users');";
  for (const t of [trunc, schema]) {
    assert.equal(
      unguardedTruncates(`describe('s',()=>{beforeEach(async()=>{${t}});});`).length,
      1,
      t,
    );
  }
});

test("a tagged-template TRUNCATE is checked, not skipped", () => {
  // `$executeRaw` is a tagged template in ordinary Prisma use. The call
  // pattern matched the backtick while the extent scan only counted
  // brackets, so it returned null and the statement was skipped entirely —
  // the common form going unchecked.
  const guard = "await assertConnectedToTestDatabase(p);";
  const tagged = "await p.$executeRaw`TRUNCATE TABLE t`;";

  assert.equal(
    unguardedTruncates(
      `describe('s',()=>{beforeEach(async()=>{${tagged}});});`,
    ).length,
    1,
    "an unguarded tagged-template truncate must be reported",
  );

  assert.deepEqual(
    unguardedTruncates(
      `describe('s',()=>{beforeAll(async()=>{${guard}});beforeEach(async()=>{${tagged}});});`,
    ),
    [],
    "a guarded one must be accepted",
  );
});

test("an unawaited guard does not count", () => {
  // Jest proceeds before the database-name query resolves, which is exactly
  // the race the guard removes.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const bare = `describe('s',()=>{beforeAll(()=>{assertConnectedToTestDatabase(p);});beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(bare).length, 1, "a bare call must not count");

  for (const form of [
    "await assertConnectedToTestDatabase(p);",
    "return assertConnectedToTestDatabase(p);",
  ]) {
    assert.deepEqual(
      unguardedTruncates(
        `describe('s',()=>{beforeAll(async()=>{${form}});beforeEach(async()=>{${trunc}});});`,
      ),
      [],
      `must accept: ${form}`,
    );
  }
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

test("prose containing a raw-SQL call is not a real statement", () => {
  // `code` keeps strings so the SQL inside a real call stays visible, which
  // also means a test title mentioning one reads as code unless the CALL
  // token is checked against the strings-stripped view.
  const prose = [
    "describe('s',()=>{",
    "  it('mentions $executeRawUnsafe(\"TRUNCATE users\") in its name',()=>{});",
    "});",
  ].join("\n");
  assert.deepEqual(unguardedTruncates(prose), [], "prose must be inert");

  // ...while the real call beside it is still caught.
  const real = [
    "describe('s',()=>{",
    "  it('mentions $executeRawUnsafe(\"TRUNCATE users\")',()=>{});",
    "  beforeEach(async()=>{await p.$executeRawUnsafe('TRUNCATE TABLE t');});",
    "});",
  ].join("\n");
  assert.equal(unguardedTruncates(real).length, 1);
});

test("describe.each scopes its callback, not its cases argument", () => {
  // `describe.each(cases)(name, cb)` is two calls. Matching to the first `(`
  // gave the extent of `cases`, so a guard inside the callback had no
  // enclosing scope, read as file-level, and covered truncates elsewhere.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const leaky = [
    "describe('outer',()=>{",
    `  describe.each([1,2])('inner %i',()=>{beforeAll(async()=>{${guard}});});`,
    `  beforeEach(async()=>{${trunc}});`,
    "});",
  ].join("\n");
  assert.equal(
    unguardedTruncates(leaky).length,
    1,
    "a guard inside describe.each must not cover the parent",
  );

  // And it still covers its own body.
  const contained = [
    `describe.each([1,2])('s %i',()=>{`,
    `  beforeAll(async()=>{${guard}});`,
    `  beforeEach(async()=>{${trunc}});`,
    "});",
  ].join("\n");
  assert.deepEqual(unguardedTruncates(contained), []);
});

test("describe.each scopes its callback in the tagged-table form too", () => {
  // Jest's other `each` spelling: describe.each`a | b`(name, cb). Handling
  // only the parenthesised form left this one scoped to its TABLE, so a
  // guard in the callback read as file-level.
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  const leaky = [
    "describe('outer',()=>{",
    "  describe.each`",
    "    a",
    "    ${1}",
    `  \`('inner',()=>{beforeAll(async()=>{${guard}});});`,
    `  beforeEach(async()=>{${trunc}});`,
    "});",
  ].join("\n");
  assert.equal(
    unguardedTruncates(leaky).length,
    1,
    "a guard inside a tagged describe.each must not cover the parent",
  );

  const contained = [
    "describe.each`",
    "  a",
    "  ${1}",
    "`('s',()=>{",
    `  beforeAll(async()=>{${guard}});`,
    `  beforeEach(async()=>{${trunc}});`,
    "});",
  ].join("\n");
  assert.deepEqual(unguardedTruncates(contained), []);
});

test("hook and describe forms Jest does not provide are not scopes", () => {
  const guard = "await assertConnectedToTestDatabase(p);";
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";

  // `suite.beforeAll(...)` is a method call, not Jest's global hook — a
  // guard inside one never runs as setup.
  assert.equal(
    unguardedTruncates(
      `describe('s',()=>{suite.beforeAll(async()=>{${guard}});beforeEach(async()=>{${trunc}});});`,
    ).length,
    1,
  );

  // Jest accepts the modifier on either side of `.each`; only one order was
  // recognised, so a guard in the other had no scope and read as file-level.
  for (const form of ["describe.only.each([1])", "describe.skip.each([1])"]) {
    assert.equal(
      unguardedTruncates(
        `describe('o',()=>{${form}('i',()=>{beforeAll(async()=>{${guard}});});beforeEach(async()=>{${trunc}});});`,
      ).length,
      1,
      `${form} must not leak its guard to the parent`,
    );
  }
});

test("SQL extracted into a variable is reported, prose is not", () => {
  // This lint cannot follow a variable to its call site. Rather than skip
  // both that and inert prose, a SQL-SHAPED string outside any call is
  // reported as an arrangement it cannot verify.
  const extracted =
    "describe('s',()=>{const sql='TRUNCATE TABLE users';beforeEach(async()=>{await p.$executeRawUnsafe(sql);});});";
  assert.equal(unguardedTruncates(extracted).length, 1);

  for (const inert of [
    "describe('s',()=>{it('rejects TRUNCATE in user input',()=>{});});",
    "describe('s',()=>{expect(e).toBe('TRUNCATE is not permitted');});",
  ]) {
    assert.deepEqual(unguardedTruncates(inert), [], inert);
  }
});

test("extracted SQL is detected in every target form, prose in none", () => {
  // Both `'TRUNCATE TABLE t'` and `'TRUNCATE is not permitted'` begin with
  // the word, so the discriminator is what follows the target list: SQL
  // permits RESTART / IDENTITY / CASCADE or the end, prose keeps going.
  const sql = [
    "TRUNCATE TABLE users",
    "TRUNCATE users",
    "TRUNCATE public.users",
    'TRUNCATE "Product", "License" RESTART IDENTITY CASCADE',
    "TRUNCATE ONLY t;",
  ];
  for (const stmt of sql) {
    const src = `describe('s',()=>{const q='${stmt}';beforeEach(async()=>{await p.$executeRawUnsafe(q);});});`;
    assert.equal(unguardedTruncates(src).length, 1, `missed: ${stmt}`);
  }

  const prose = [
    "TRUNCATE is not permitted",
    "rejects TRUNCATE in user input",
    "TRUNCATE should be blocked for untrusted callers",
  ];
  for (const text of prose) {
    const src = `describe('s',()=>{it('${text}',()=>{});});`;
    assert.deepEqual(unguardedTruncates(src), [], `false positive: ${text}`);
  }
});

test("a regex literal does not swallow the code after it", () => {
  // An apostrophe inside `/isn't/` opened a "string" that blanked everything
  // to the next quote, which could erase a raw-SQL call token and make an
  // unguarded TRUNCATE vanish from this lint.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";
  const withRegex = `describe('s',()=>{const re=/isn't valid/;beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(withRegex).length, 1);

  // A division is not a regex, and must not start one.
  const division = `describe('s',()=>{const r=a/b;const s=c/d;beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(division).length, 1);

  // Offsets survive either way.
  const src = "const re = /a'b/; const s = 'x';";
  assert.equal(stripCommentsAndStrings(src).length, src.length);
});

test("constructs this lexer cannot read are reported, not mis-read", () => {
  // The same decision the YAML checks make, one language over: no parser is
  // available in test-ci-scripts, so what cannot be read reliably is
  // declared rather than guessed at.
  const unlintable = [
    ["const re = /\\(/;", "unbalanced bracket"],
    ["const re = /[(]/;", "unbalanced bracket"],
    ["p.$executeRaw`SELECT ${a ? `x` : `y`}`;", "nested template"],
  ];
  for (const [src, why] of unlintable) {
    const found = unlintableConstructs(src);
    assert.ok(found.length > 0, `not reported: ${src}`);
    assert.match(found[0], new RegExp(why));
  }

  // Ordinary code is not. A false positive here fails a required check.
  for (const fine of [
    "const re = /isn't valid/;",
    "const re = /^truncate$/i;",
    // Balanced brackets cancel out in the extent scanners, so they are fine.
    "const re = /^\\d{6}$/;",
    "const re = /(a|b)/;",
    "const s = `plain ${value} template`;",
    "await p.$executeRawUnsafe('TRUNCATE TABLE t');",
    "const r = a / b / c;",
  ]) {
    assert.deepEqual(unlintableConstructs(fine), [], `false positive: ${fine}`);
  }
});

test("RESTRICT is a valid TRUNCATE option", () => {
  const src =
    "describe('s',()=>{const q='TRUNCATE users RESTRICT';beforeEach(async()=>{await p.$executeRawUnsafe(q);});});";
  assert.equal(unguardedTruncates(src).length, 1);
});

test("a regex at the start of a statement is recognised", () => {
  // `/[\s(]return$/` required a character before `return`, so a
  // statement-leading `return /isn't/` read as division and its apostrophe
  // opened a string that blanked the code after it.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";
  const src = `describe('s',()=>{const f=()=>{return /isn't/;};beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(src).length, 1);
});

test("SQL in a describe body is reported, however well guarded", () => {
  // A raw call directly in a describe body runs while the suite is being
  // DEFINED — before any beforeAll — so no setup-hook guard can precede it,
  // whatever the file order suggests.
  const guard = "await assertConnectedToTestDatabase(p);";
  const bare =
    `describe('s',()=>{beforeAll(async()=>{${guard}});p.$executeRawUnsafe('TRUNCATE TABLE t');});`;
  assert.equal(unguardedTruncates(bare).length, 1);

  // Inside a hook or a test it is fine.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";
  for (const ctx of [
    `beforeEach(async()=>{${trunc}});`,
    `it('x',async()=>{${trunc}});`,
    `test('x',async()=>{${trunc}});`,
    `it.each([1])('x %i',async()=>{${trunc}});`,
  ]) {
    assert.deepEqual(
      unguardedTruncates(`describe('s',()=>{beforeAll(async()=>{${guard}});${ctx}});`),
      [],
      `rejected a valid context: ${ctx}`,
    );
  }
});

test("a guard-shaped regex is not a guard", () => {
  // Regex interiors stayed verbatim in the executable view, so
  // `/await assertConnectedToTestDatabase\(/` inside a hook counted as a
  // real call and covered a later truncate.
  const trunc = "await p.$executeRawUnsafe('TRUNCATE TABLE t');";
  const fake = `describe('s',()=>{beforeAll(()=>{const re=/await assertConnectedToTestDatabase\\(x/;});beforeEach(async()=>{${trunc}});});`;
  assert.equal(unguardedTruncates(fake).length, 1);

  // The interior is blanked, and offsets still line up.
  assert.ok(!stripCommentsAndStrings("const re = /secret/;").includes("secret"));
  const src = "const re = /a'b/; const s = 'x';";
  assert.equal(stripCommentsAndStrings(src).length, src.length);
});

test("quoted and schema-qualified TRUNCATE targets are detected", () => {
  // Each component may be quoted independently, and this repo's own specs
  // use the `"Product", "License"` form.
  for (const stmt of [
    'TRUNCATE "public"."User"',
    'TRUNCATE public."User"',
    'TRUNCATE "User"',
    "TRUNCATE public.users",
  ]) {
    const src = `describe('s',()=>{const q='${stmt}';beforeEach(async()=>{await p.$executeRawUnsafe(q);});});`;
    assert.equal(unguardedTruncates(src).length, 1, `missed: ${stmt}`);
  }
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
