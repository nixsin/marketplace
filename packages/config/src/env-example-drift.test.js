import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ENV_CONTRACT, WEB_ENV_CONTRACT } from "./env-contract.js";
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

test("apps/api/.env.example declares every API variable", () => {
  const declared = declaredInEnvFile(read("apps/api/.env.example"));
  assert.deepEqual(
    missing(API_ENV_CONTRACT, declared),
    [],
    "every contract variable must appear in the example CI copies verbatim",
  );
});

test("apps/web/.env.example declares every web variable", () => {
  const declared = declaredInEnvFile(read("apps/web/.env.example"));
  assert.deepEqual(missing(WEB_ENV_CONTRACT, declared), []);
});

test("docker-compose.yml declares every variable for both services", () => {
  // Compose forwards nothing from the host, so anything absent here is
  // absent inside the container -- including in docker-smoke, a required
  // check that would then be exercising a configuration nobody wrote down.
  const declared = declaredInYaml(read("docker-compose.yml"));
  assert.deepEqual(missing(API_ENV_CONTRACT, declared), [], "api service");
  assert.deepEqual(missing(WEB_ENV_CONTRACT, declared), [], "web service");
});

test("ci.yml declares every web variable at workflow level", () => {
  // apps/web is built or booted by six separate CI steps. They inherit one
  // workflow-level env block; a variable missing from it is missing from all
  // six, and @medinstru/config/web throws rather than invent a value.
  const declared = declaredInYaml(read(".github/workflows/ci.yml"));
  assert.deepEqual(missing(WEB_ENV_CONTRACT, declared), []);
});

test("the localhost values are the ones @medinstru/config defines", () => {
  // The URLs exist as constants precisely so six files stop each carrying
  // their own literal. A file that drifts from the constant is the failure
  // those constants were added to prevent.
  const api = read("apps/api/.env.example");
  const web = read("apps/web/.env.example");

  assert.match(web, new RegExp(DEV_API_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(web, new RegExp(DEV_SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(api, new RegExp(`PORT="?${API_DEFAULT_PORT}"?`));
});
