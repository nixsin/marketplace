import { test } from "node:test";
import assert from "node:assert/strict";
import { envFilesFor, parseArgs } from "./check-env-args.mjs";

const ENVS = ["render", "github-ci", "ci-local", "test", "localhost", "unknown"];

test("no arguments checks both apps", () => {
  const result = parseArgs([], ENVS);
  assert.deepEqual(result.apps, ["api", "web"]);
  assert.equal(result.forced, undefined);
});

test("--env's value is not mistaken for the app", () => {
  // The bug this file exists for: `argv.find(a => !a.startsWith("-"))` picked
  // up "render" whenever no app was given, so a valid invocation exited with
  // `Unknown app "render"`.
  const result = parseArgs(["--env", "render"], ENVS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.apps, ["api", "web"]);
  assert.equal(result.forced, "render");
});

test("an app and --env together still work in either order", () => {
  for (const argv of [
    ["api", "--env", "render"],
    ["--env", "render", "api"],
  ]) {
    const result = parseArgs(argv, ENVS);
    assert.equal(result.ok, true, argv.join(" "));
    assert.deepEqual(result.apps, ["api"], argv.join(" "));
    assert.equal(result.forced, "render", argv.join(" "));
  }
});

test("--env with nothing after it is refused, not read as undefined", () => {
  const result = parseArgs(["--env"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /needs a value/);
});

test("--env followed by another flag is refused", () => {
  // `--env --list` would otherwise take "--list" as the environment.
  const result = parseArgs(["--env", "--list"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /needs a value/);
});

test("an unknown environment is refused with the accepted list", () => {
  const result = parseArgs(["--env", "staging"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /Unknown --env "staging"/);
  assert.match(result.message, /render/);
});

test("an unknown app is refused", () => {
  const result = parseArgs(["mobile"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /Unknown app "mobile"/);
});

test("two apps are refused rather than silently taking the first", () => {
  const result = parseArgs(["api", "web"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /Expected one app/);
});

test("--list and --show are recognised anywhere", () => {
  const result = parseArgs(["--show", "api", "--list"], ENVS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.apps, ["api"]);
  assert.equal(result.list, true);
  assert.equal(result.show, true);
});

test("an unknown flag is refused rather than ignored", () => {
  // Every flag selects a different operation, so skipping an unrecognised
  // one runs the wrong operation and reports success.
  for (const bad of ["--lis", "--showw", "--verbose", "-l"]) {
    const result = parseArgs([bad], ENVS);
    assert.equal(result.ok, false, `${bad} should be refused`);
    assert.equal(result.code, 2);
    assert.match(result.message, /Unknown option/);
  }
});

test("--env=render is refused with the form that works", () => {
  // The worst of the silent cases: it leaves `forced` undefined, so the CLI
  // checks the environment you are in rather than the one you asked about --
  // the single question this tool exists to answer differently.
  const result = parseArgs(["--env=render"], ENVS);
  assert.equal(result.ok, false);
  assert.match(result.message, /--env render/);

  const listEquals = parseArgs(["--list=true"], ENVS);
  assert.equal(listEquals.ok, false);
  assert.match(listEquals.message, /--list true/);
});

test("every valid invocation still parses", () => {
  // The guard runs before everything else, so a regression in it breaks the
  // whole CLI rather than one flag.
  for (const argv of [
    [],
    ["api"],
    ["web", "--list"],
    ["--show"],
    ["--env", "render"],
    ["api", "--env", "render", "--show"],
  ]) {
    const result = parseArgs(argv, ENVS);
    assert.equal(result.ok, true, `${JSON.stringify(argv)} should parse`);
  }
});

test("the API reads .env alone, whatever NODE_ENV says", () => {
  // Nest's ConfigModule default. An apps/api/.env.local is read by nothing,
  // so reporting values from one would describe a configuration the service
  // never sees.
  for (const nodeEnv of ["development", "production", "test"]) {
    assert.deepEqual(envFilesFor("api", nodeEnv), [".env"]);
  }
});

test("the web app reads Next's list in Next's order", () => {
  assert.deepEqual(envFilesFor("web", "development"), [
    ".env.development.local",
    ".env.local",
    ".env.development",
    ".env",
  ]);

  assert.deepEqual(envFilesFor("web", "production"), [
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]);
});

test("the web app skips .env.local under test, matching Next", () => {
  // Next excludes it deliberately, so a developer's local overrides cannot
  // change what a test run sees. A checker that read it would report a
  // configuration the test run does not have.
  const files = envFilesFor("web", "test");
  assert.ok(!files.includes(".env.local"));
  assert.deepEqual(files, [".env.test.local", ".env.test", ".env"]);
});

test("every list ends at .env, and lists highest precedence first", () => {
  // The loader relies on both: process.loadEnvFile never overwrites an
  // already-set value, so the order IS the precedence, and `.env` last is
  // what makes it the fallback rather than the winner.
  for (const app of ["api", "web"]) {
    for (const nodeEnv of ["development", "production", "test"]) {
      const files = envFilesFor(app, nodeEnv);
      assert.equal(files[files.length - 1], ".env");
      assert.equal(new Set(files).size, files.length, "no duplicates");
    }
  }
});

test("a repeated flag is refused", () => {
  // Only the first occurrence is read, so a second one silently answers a
  // different question than the one typed.
  for (const argv of [
    ["--env", "render", "--env"],
    ["--env", "render", "--env", "localhost"],
    ["--list", "--list"],
    ["--show", "api", "--show"],
  ]) {
    const result = parseArgs(argv, ENVS);
    assert.equal(result.ok, false, `${JSON.stringify(argv)} should be refused`);
    assert.match(result.message, /more than once/);
  }
});

test("an unrecognised NODE_ENV falls back to production, not a made-up file", () => {
  // Next only ever uses development/production/test and sets NODE_ENV itself.
  // Interpolating whatever is in the environment sent this looking for
  // `.env.staging.local` -- a file Next never reads -- so the checker would
  // report values from somewhere the app does not look, which is the exact
  // failure the per-app split exists to prevent.
  const production = envFilesFor("web", "production");
  for (const odd of ["staging", "", "PRODUCTION", "dev", "qa"]) {
    assert.deepEqual(
      envFilesFor("web", odd),
      production,
      `NODE_ENV=${JSON.stringify(odd)} should fall back to production`,
    );
  }

  // No file name may carry an unrecognised mode into it.
  for (const odd of ["staging", "qa"]) {
    for (const file of envFilesFor("web", odd)) {
      assert.ok(!file.includes(odd), `${file} leaked ${odd}`);
    }
  }
});
