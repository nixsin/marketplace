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
  DEV_SITE_URL,
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

test("the only compose overrides are the Docker-network hostnames", () => {
  // An override is a value that is NOT the development one, so each is a
  // small divergence worth keeping deliberate. Two is correct: Postgres and
  // Redis answer on service names inside the network. A third appearing
  // silently is how the dev stack starts differing from a laptop.
  const compose = read("docker-compose.yml");
  const overrides = [...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]*): /gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(overrides)].sort(),
    ["DATABASE_URL", "POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER", "REDIS_URL"],
    "unexpected compose override — should the value differ from a laptop's?",
  );
});

test("ci.yml declares every web variable at workflow level", () => {
  // apps/web is built or booted by six separate CI steps. They inherit one
  // workflow-level env block; a variable missing from it is missing from all
  // six. GitHub Actions has no env_file, so this one stays declared -- and
  // therefore stays tested.
  const declared = declaredInYaml(read(".github/workflows/ci.yml"));
  assert.deepEqual(missing(WEB_ENV_CONTRACT, declared), []);
});

test("the localhost values are the ones @medinstru/config defines", () => {
  // The constants exist precisely so several files stop each carrying their
  // own literal. A file that drifts from the constant is the failure they
  // were added to prevent.
  const ci = read(".github/workflows/ci.yml");
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(ci, new RegExp(escape(DEV_API_URL)));
  assert.match(ci, new RegExp(escape(DEV_SITE_URL)));
  assert.match(read("apps/api/.env.example"), new RegExp(`PORT="?${API_DEFAULT_PORT}"?`));
});
