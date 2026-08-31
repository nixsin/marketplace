import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_ENV_CONTRACT,
  WEB_ENV_CONTRACT,
  renderEnvExample,
} from "./env-contract.js";
import {
  API_DEFAULT_PORT,
  DEV_API_URL,
  DEV_POSTGRES_DB,
  DEV_POSTGRES_PASSWORD,
  DEV_POSTGRES_USER,
  DEV_SITE_URL,
  POSTGRES_PORT,
  REDIS_PORT,
  WEB_DEFAULT_PORT,
} from "./index.js";

/**
 * The contract says every environment declares every variable. Four of those
 * environments are files that cannot import JavaScript -- two .env.example
 * files, docker-compose.yml and ci.yml -- so nothing but a test can hold them
 * to it.
 *
 * This is the "enforced" half of "defined in config and enforced in a script".
 * Without it the contract is a claim about the code and a hope about the YAML,
 * and the two drift in the direction that is invisible: a variable added to
 * the contract simply never appears in CI, and the job that would have caught
 * it is the job now running without the variable.
 *
 * Same shape as scripts/cloudflare-locale-drift.test.mjs, which pins Terraform
 * to LOCALES for the same reason.
 */

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (relative) => readFileSync(join(REPO, relative), "utf8");

/** Names declared in a dotenv-style file, quoted or not, empty or not. */
function declaredInEnvFile(contents) {
  return new Set(
    contents
      .split("\n")
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter(Boolean),
  );
}

/** Names declared anywhere in a YAML file, as `NAME:` or `NAME=`. */
function declaredInYaml(contents) {
  const names = new Set();
  for (const line of contents.split("\n")) {
    const match = /^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Split a workflow into its jobs, so a per-job invariant can be asserted. */
function splitJobs(contents) {
  const jobs = {};
  let name = null;
  let body = [];
  // Start AFTER the `jobs:` key. The `on:` block above it also contains
  // two-space keys (`pull_request:`, `workflow_dispatch:`), so scanning the
  // whole file swept the trigger config into the first "job" and every
  // assertion then ran against the wrong text.
  const jobsAt = contents.indexOf("\njobs:\n");
  const body_text = jobsAt === -1 ? contents : contents.slice(jobsAt + "\njobs:\n".length);
  for (const line of body_text.split("\n")) {
    const match = /^  ([a-z][a-z0-9-]*):$/.exec(line);
    if (match) {
      if (name) jobs[name] = body.join("\n");
      name = match[1];
      body = [];
    } else if (name) {
      body.push(line);
    }
  }
  if (name) jobs[name] = body.join("\n");
  return jobs;
}

/**
 * Does this job actually build or boot the web app?
 *
 * Deliberately narrow. A first version matched any mention of
 * `apps/web/Dockerfile`, which flagged the `changes` job -- that path appears
 * in its dorny/paths-filter config, not in a build command. A test that
 * reports a job needing something it does not is a test people learn to edit
 * rather than believe.
 */
function buildsWeb(body) {
  return (
    // The path must sit on the `docker build` line itself, not anywhere.
    /docker build[^\n]*apps\/web\/Dockerfile/.test(body) ||
    // Anything running inside apps/web loads next.config.ts.
    /working-directory: apps\/web/.test(body) ||
    /playwright test/.test(body)
  );
}

const missing = (required, declared) =>
  required.map((r) => r.name).filter((name) => !declared.has(name));

test("both .env.example files are current", () => {
  // They are GENERATED from the contract now, so the only way they can be
  // wrong is being stale. `node scripts/generate-env-example.mjs` fixes it,
  // and test-ci-scripts runs the same check with --check.
  for (const [app, rules] of [["api", API_ENV_CONTRACT], ["web", WEB_ENV_CONTRACT]]) {
    const committed = read(`apps/${app}/.env.example`);
    assert.equal(
      committed,
      renderEnvExample(app),
      `apps/${app}/.env.example is stale — run node scripts/generate-env-example.mjs`,
    );
    // Belt and braces: the generator is what guarantees completeness, so
    // assert the property directly rather than trusting the generator's own
    // loop. A generator bug would otherwise produce a file that matches
    // itself and is missing half the contract.
    const declared = declaredInEnvFile(committed);
    assert.deepEqual(missing(rules, declared), []);
  }
});

test("docker-compose reads the generated files rather than copying them", () => {
  // Compose forwards nothing from the host, so every variable has to come
  // from somewhere inside this file. It used to be ~16 duplicated literals
  // held in step only by a test; now it is env_file pointing at the
  // generated example, which is complete by construction.
  const compose = read("docker-compose.yml");
  assert.match(compose, /env_file:\s*\n\s*- \.\/apps\/api\/\.env\.example/);
  assert.match(compose, /env_file:\s*\n\s*- \.\/apps\/web\/\.env\.example/);
});

test("docker-compose.yml declares no environment values of its own", () => {
  // Every value now arrives through a generated env_file. An `environment:`
  // block reappearing means somebody wrote a literal back in, and a literal
  // is what drifts.
  const compose = read("docker-compose.yml");
  assert.doesNotMatch(
    compose,
    /^\s{4}environment:/m,
    "compose should get values from env_file, not declare them",
  );
});

test("the compose port mappings are the ports @medinstru/config defines", () => {
  // These CANNOT come from a generated file: compose resolves `ports:` from
  // the file itself, and variable substitution would still need a literal
  // default. So they are pinned instead -- a port changed in one place and
  // not the other produces a stack that starts and cannot talk to itself.
  const compose = read("docker-compose.yml");
  for (const port of [POSTGRES_PORT, REDIS_PORT, API_DEFAULT_PORT, WEB_DEFAULT_PORT]) {
    assert.match(
      compose,
      new RegExp(`"${port}:${port}"`),
      `docker-compose.yml should map port ${port}`,
    );
  }
});

test("CI's Postgres service account matches what the app connects with", () => {
  // The one hand-written declaration left in ci.yml. `services:` is evaluated
  // when a JOB STARTS, before any step runs, so nothing a step writes to
  // $GITHUB_ENV can reach it and Actions has no env_file -- consolidating to
  // one workflow-level block and pinning it here is the best available.
  //
  // If these drift from the URL the app uses, every API job fails to connect
  // with an authentication error that names neither file.
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, new RegExp(`^  POSTGRES_USER: ${DEV_POSTGRES_USER}$`, "m"));
  assert.match(ci, new RegExp(`^  POSTGRES_PASSWORD: ${DEV_POSTGRES_PASSWORD}$`, "m"));
  assert.match(ci, new RegExp(`^  POSTGRES_DB: ${DEV_POSTGRES_DB}$`, "m"));

  // And declared exactly once: three jobs used to carry their own copy.
  const declarations = [...ci.matchAll(/^\s*POSTGRES_USER: (?!\$\{\{)/gm)];
  assert.equal(declarations.length, 1, "POSTGRES_USER should be declared once");
});

test("ci.yml carries no connection strings", () => {
  // DATABASE_URL used to be written out in three jobs. It comes from
  // scripts/ci-env.mjs now; the only remaining occurrence is the production
  // secret reference, which is not a value.
  const ci = read(".github/workflows/ci.yml");
  const literals = [...ci.matchAll(/^\s*DATABASE_URL: (.+)$/gm)].map((m) => m[1]);
  for (const value of literals) {
    assert.match(
      value,
      /^\$\{\{ secrets\./,
      `ci.yml hardcodes a connection string: ${value}`,
    );
  }
});

test("every job that builds or boots the web app loads its environment", () => {
  // ci.yml no longer declares these values -- `node scripts/ci-env.mjs web`
  // emits them from the contract into $GITHUB_ENV. What can go wrong now is
  // a NEW job that builds the web app and forgets the step, which fails in a
  // way that looks like a code problem rather than a missing line of YAML.
  const ci = read(".github/workflows/ci.yml");
  const jobs = splitJobs(ci);

  for (const [name, body] of Object.entries(jobs)) {
    if (!buildsWeb(body)) continue;

    assert.match(
      body,
      /node scripts\/ci-env\.mjs web >> "\$GITHUB_ENV"/,
      `job "${name}" builds or boots the web app but never declares its environment`,
    );
  }
});

test("the environment is loaded BEFORE anything that consumes it", () => {
  // $GITHUB_ENV only affects SUBSEQUENT steps, never the one that writes it.
  // A load step placed after the build is invisible: the build runs with
  // nothing and the step still reports success.
  const ci = read(".github/workflows/ci.yml");
  for (const [name, body] of Object.entries(splitJobs(ci))) {
    const load = body.indexOf("scripts/ci-env.mjs web");
    if (load === -1) continue;

    for (const consumer of ["pnpm build", "apps/web/Dockerfile", "playwright test"]) {
      const at = body.indexOf(consumer);
      if (at === -1) continue;
      assert.ok(
        load < at,
        `job "${name}" runs "${consumer}" before declaring the environment`,
      );
    }
  }
});

test("ci.yml no longer hardcodes the values", () => {
  // The point of the change. If these reappear it means somebody re-added a
  // declaration block rather than using the emitter, and the two will drift.
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(
    ci,
    /^\s*NEXT_PUBLIC_API_URL:\s/m,
    "ci.yml should get this from scripts/ci-env.mjs, not declare it",
  );
});

test("the localhost values are the ones @medinstru/config defines", () => {
  // The constants exist precisely so several files stop each carrying their
  // own literal. A file that drifts from the constant is the failure they
  // were added to prevent.
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const web = read("apps/web/.env.example");
  assert.match(web, new RegExp(escape(DEV_API_URL)));
  assert.match(web, new RegExp(escape(DEV_SITE_URL)));
  assert.match(read("apps/api/.env.example"), new RegExp(`PORT="?${API_DEFAULT_PORT}"?`));
});

test("ci-env.mjs imports the contract by relative path, not by package name", () => {
  // LOAD-BEARING, and it looks exactly like something to tidy up.
  // `docker-scan` and `docker-web-prod-boot` run only `actions/checkout` --
  // no pnpm, no install -- so `@medinstru/config/env-contract` would not
  // resolve there. A relative import needs nothing but node.
  const script = read("scripts/ci-env.mjs");
  assert.match(script, /from "\.\.\/packages\/config\/src\/env-contract\.js"/);
  assert.doesNotMatch(
    script,
    /from "@medinstru\/config/,
    "would break the CI jobs that never run pnpm install",
  );
});

test("the config package itself has no external imports", () => {
  // The reason the relative import above is enough. If either file grew a
  // dependency, ci-env.mjs would start failing in exactly those two jobs.
  for (const file of ["index.js", "env-contract.js"]) {
    const source = read(`packages/config/src/${file}`);
    const imports = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("."),
        `${file} imports "${specifier}" — ci-env.mjs runs without node_modules`,
      );
    }
  }
});
