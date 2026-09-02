import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./check-env-args.mjs";

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
