/**
 * End-to-end tests for scripts/check-env.mjs.
 *
 * Separate from check-env-args.test.mjs, which covers the parsing decisions
 * in isolation. This file runs the REAL CLI as a subprocess, because the
 * parts it covers -- loading each app's .env, letting the shell win over the
 * file, restoring process.env between apps, and the exit codes -- are all
 * side effects on a live process that a unit test cannot observe.
 *
 * They matter for the reason the loader's own comments give: a failure here
 * misreports an otherwise correct check, which is worse than not checking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const CLI = fileURLToPath(new URL("./check-env.mjs", import.meta.url));

// Read from the contract rather than listed by hand, so a variable added
// later is stripped too instead of quietly re-entering through the shell.
const { CONTRACTS } = await import(
  "../packages/config/src/env-contract.js"
);
const CONTRACT_VARIABLES = Object.values(CONTRACTS)
  .flat()
  .map((rule) => rule.name);

/**
 * A complete, valid environment for each app, supplied by the TEST.
 *
 * These used to lean on the repo's own committed .env files, which pass on a
 * developer machine and does not exist in CI at all -- every .env is
 * gitignored. The suite was therefore asserting a property of one laptop.
 * Building the environment here makes the same assertions true everywhere,
 * and it doubles as the readable statement of what a valid one looks like.
 */
const VALID = Object.fromEntries(
  Object.entries(CONTRACTS).map(([app, rules]) => [
    app,
    Object.fromEntries(rules.map((rule) => [rule.name, rule.devValue])),
  ]),
);
const VALID_BOTH = { ...VALID.api, ...VALID.web };

/**
 * Drop keys from a fixture. Setting one to `undefined` does NOT work: the
 * child process receives the literal string "undefined", which is a value
 * and passes "is it declared" while failing every rule after it.
 */
function omit(source, ...keys) {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * A CONTROLLED BASELINE, not the ambient environment.
 *
 * process.loadEnvFile never overwrites an already-set value, so any contract
 * variable exported in the developer's shell -- or `RENDER` / `APP_ENV` left
 * over from another experiment -- changes what these tests observe and what
 * the CLI detects. They would then pass or fail based on the machine rather
 * than the code, which is the one thing a test must never do.
 *
 * PATH and friends are kept because the subprocess needs them to run at all;
 * everything the contract or detection reads is stripped.
 */
function baselineEnv() {
  const stripped = new Set([
    "APP_ENV",
    "RENDER",
    "RENDER_GIT_COMMIT",
    "CI",
    "GITHUB_ACTIONS",
    "NODE_ENV",
    "VITEST",
    "JEST_WORKER_ID",
    ...CONTRACT_VARIABLES,
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !stripped.has(key)),
  );
}


/**
 * Run `body` with an extra apps/web/.env.local in place, then put the tree
 * back exactly as it was.
 *
 * `.env.local` is gitignored, so it EXISTS on a developer machine and does
 * not in CI. Both cases have to be handled: restore contents where there
 * were contents, remove the file where there was no file. Otherwise the
 * suite either fails in CI on a missing file or leaves one behind on a
 * laptop.
 */
function withEnvFile(relativePath, contents, body) {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : "";
  try {
    writeFileSync(path, `${original}\n${contents}\n`);
    body();
  } finally {
    if (existed) writeFileSync(path, original);
    else rmSync(path, { force: true });
  }
}

const withWebEnvLocal = (contents, body) =>
  withEnvFile("apps/web/.env.local", contents, body);

/** @returns {{status: number, out: string}} */
function run(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...baselineEnv(), ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (error) {
    return {
      status: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

test("a complete environment passes for both apps", () => {
  const { status, out } = run(["all"], VALID_BOTH);
  assert.equal(status, 0, out);
  assert.match(out, /app: api/);
  assert.match(out, /app: web/);
  assert.ok(!out.includes("is not declared"), out);
});


test("an explicit variable wins over the .env file", () => {
  // process.loadEnvFile never overwrites an already-set value, and the CLI
  // depends on that: `FOO=bar node scripts/check-env.mjs` must check `bar`.
  withWebEnvLocal('NEXT_PUBLIC_SITE_URL="https://from-the-file.example.com"', () => {
    const fromFile = run(["web"], omit(VALID.web, "NEXT_PUBLIC_SITE_URL"));
    assert.equal(fromFile.status, 0, fromFile.out);

    // The shell's value must win, and be the one reported. `--show` prints
    // the banner, which lists values; the plain report only says OK.
    const overridden = run(["web", "--show"], {
      ...VALID.web,
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
    assert.equal(overridden.status, 0, overridden.out);
    assert.match(overridden.out, /localhost:3000/);
    assert.ok(!overridden.out.includes("from-the-file"), overridden.out);
  });
});

test("one app's file values do not leak into the other's report", () => {
  // THE VARIABLE HAS TO BE IN BOTH CONTRACTS for the leak to be visible, and
  // an earlier version of this test missed that: it passed every variable in
  // the subprocess environment, so the files could not introduce anything at
  // all and the restore it claimed to exercise was never touched.
  //
  // NEXT_PUBLIC_SITE_URL is in both. Giving each app's own file a distinct
  // value and supplying neither from the shell means the API's value is in
  // process.env by the time the web app is read — and since loadEnvFile
  // never overwrites, a missing restore makes the web report show the API's.
  const shared = omit(VALID_BOTH, "NEXT_PUBLIC_SITE_URL");

  withEnvFile(
    "apps/api/.env",
    'NEXT_PUBLIC_SITE_URL="http://localhost:3000/#from-the-api-file"',
    () => {
      withWebEnvLocal(
        'NEXT_PUBLIC_SITE_URL="http://localhost:3000/#from-the-web-file"',
        () => {
          const { out } = run(["all", "--show"], shared);
          const webSection = out.slice(out.indexOf("app: web"));

          assert.match(
            webSection,
            /from-the-web-file/,
            `the web app must see its own file:\n${out}`,
          );
          assert.ok(
            !webSection.includes("from-the-api-file"),
            `the API's value leaked into the web report:\n${out}`,
          );
        },
      );
    },
  );
});

test("localhost values fail the production rules", () => {
  // The dry run's whole purpose: the same environment, judged where it would
  // actually have to work.
  const { status, out } = run(["api", "--env", "render"], VALID_BOTH);
  assert.equal(status, 1, out);
  assert.match(out, /ERROR/);
});

test("a usage error exits 2, distinct from a configuration failure", () => {
  // The two must not share an exit code: a script reacting to a bad
  // configuration should not also fire on a typo in its own invocation.
  for (const argv of [["nope"], ["--lis"], ["--env", "bogus"], ["--env"]]) {
    const { status } = run(argv);
    assert.equal(status, 2, `${JSON.stringify(argv)} should exit 2`);
  }
});

test("--env render reports the APP_ENV that could not be right there", () => {
  const { out } = run(["api", "--env", "render"], VALID_BOTH);
  assert.match(out, /APP_ENV/);
  assert.match(out, /must itself be "render"/);
});

test("--list prints the contract without needing a valid environment", () => {
  const { status, out } = run(["api", "--list"]);
  assert.equal(status, 0, out);
  assert.match(out, /DATABASE_URL/);
  assert.match(out, /WHATSAPP_TEMPLATE_NAME/);
});

test("--env render reads the production env files, not the development ones", () => {
  // The interaction the unit tests cover separately: readAppEnv used to
  // select files from the ambient NODE_ENV while the forced target only
  // reached checkEnv, so a dry run against Render judged development values
  // by production rules.
  //
  // Observable because apps/web/.env.local exists and .env.production does
  // not: under a forced render target the loader must still find .env.local
  // (Next reads it in production too) while asking for .env.production
  // rather than .env.development.
  const { status, out } = run(["web", "--env", "render"], VALID_BOTH);
  assert.equal(status, 1, out);
  assert.match(out, /environment: render/);
  // A missing .env.production is not an error — absent is a legal state.
  assert.ok(!out.includes("Could not read"), out);
});

test("a web .env value using expansion is resolved, not judged literally", () => {
  // The provenance split, end to end. Next expands a web .env file through
  // dotenv-expand, so judging `$PUBLIC_ORIGIN` as text reports a working
  // configuration as broken. The loader resolves it before the contract
  // sees it, which is why the contract needs no special case.
  withWebEnvLocal(
    'PUBLIC_ORIGIN="https://laxair.shop"\nNEXT_PUBLIC_SITE_URL=$PUBLIC_ORIGIN',
    () => {
      const { status, out } = run(["web"], omit(VALID.web, "NEXT_PUBLIC_SITE_URL"));
      assert.equal(status, 0, out);
      assert.ok(!out.includes("$PUBLIC_ORIGIN"), out);
    },
  );
});

test("the same syntax in the ENVIRONMENT is still judged literally", () => {
  // Nothing expands a value already in process.env — not the Render
  // dashboard, not a shell export, not a Docker ENV. So `$KEY` there is a
  // four-character signing key, and skipping the length check to avoid a
  // hypothetical false positive would wave it through.
  const { status, out } = run(["web"], {
    ...VALID.web,
    SOURCEMAP_SIGNING_KEY: "$KEY",
  });
  assert.equal(status, 1, out);
  assert.match(out, /SOURCEMAP_SIGNING_KEY/);
  assert.match(out, /at least 32 characters/);
});
