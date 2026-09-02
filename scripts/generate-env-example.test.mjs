/**
 * Tests for scripts/generate-env-example.mjs.
 *
 * Runs the real script as a subprocess: what matters is the exit code and the
 * files on disk, and neither is observable by importing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTRACTS,
  checkEnv,
} from "../packages/config/src/env-contract.js";

const SCRIPT = fileURLToPath(
  new URL("./generate-env-example.mjs", import.meta.url),
);
const GENERATED = [
  "apps/api/.env.example",
  "apps/web/.env.example",
  "docker/dev.env",
];

const resolve = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

function run(args = []) {
  try {
    return {
      status: 0,
      out: execFileSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/** Edit a generated file, run `body`, then put it back byte for byte. */
function withEdited(path, append, body) {
  const full = resolve(path);
  const original = readFileSync(full, "utf8");
  try {
    writeFileSync(full, original + append);
    body();
  } finally {
    writeFileSync(full, original);
  }
}

test("the committed files match the contract", () => {
  // The check CI runs. If this fails here, regenerate — the contract changed
  // and the committed files were not updated with it.
  const { status, out } = run(["--check"]);
  assert.equal(status, 0, out);
});

test("--check fails when a file is edited by hand", () => {
  // Without this the generator is only a suggestion: someone edits a rule,
  // forgets to regenerate, and the committed file describes a contract that
  // no longer exists.
  withEdited("apps/web/.env.example", "\n# hand-edited\n", () => {
    const { status, out } = run(["--check"]);
    assert.equal(status, 1, out);
    assert.match(out, /apps\/web\/\.env\.example/);
    assert.match(out, /generate-env-example/, "it must say how to fix it");
  });
});

test("--check names every stale file, not just the first", () => {
  withEdited("apps/api/.env.example", "\n# a\n", () => {
    withEdited("docker/dev.env", "\n# b\n", () => {
      const { out } = run(["--check"]);
      assert.match(out, /apps\/api\/\.env\.example/);
      assert.match(out, /docker\/dev\.env/);
    });
  });
});

test("--check ignores a trailing-newline difference", () => {
  // Editors add one. A diff over whitespace nobody can see would train
  // people to rerun the generator for no reason.
  withEdited("apps/api/.env.example", "\n\n\n", () => {
    const { status } = run(["--check"]);
    assert.equal(status, 0);
  });
});

test("writing is idempotent", () => {
  const before = GENERATED.map((p) => readFileSync(resolve(p), "utf8"));
  run();
  const after = GENERATED.map((p) => readFileSync(resolve(p), "utf8"));
  assert.deepEqual(after, before);
});

test("each app's file declares exactly its own contract, in order", () => {
  // A rule that produced no line means a variable required at boot and
  // missing from the file people copy.
  for (const [app, rules] of Object.entries(CONTRACTS)) {
    const text = readFileSync(resolve(`apps/${app}/.env.example`), "utf8");
    const declared = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      declared,
      rules.map((r) => r.name),
      `apps/${app}/.env.example does not match its contract`,
    );
  }
});

test("no committed secret could pass as a production value", () => {
  // These files are committed, and a committed credential stays in git
  // history forever. The values here are not all empty — JWT_SECRET is the
  // placeholder `dev-secret-change-me`, DATABASE_URL is the throwaway
  // account the local Postgres container creates — so "is it empty" is the
  // wrong test.
  //
  // The property that matters is that NONE of them would be accepted in
  // production. Checked with the contract's own production rules rather than
  // a second opinion about what a secret looks like.
  const text = readFileSync(resolve("apps/api/.env.example"), "utf8");
  const env = Object.fromEntries(
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)="?([^"\n]*)"?$/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );

  const result = checkEnv({ app: "api", env, environment: "render" });
  const reported = result.errors.map((e) => e.message).join("\n");

  // Empty OR rejected. Both are safe and the split is real: REDIS_URL is a
  // secret whose EMPTY value is legal in production — a null cache is a
  // supported state — so production has nothing to complain about. What must
  // never happen is a committed secret carrying a value production accepts.
  for (const rule of CONTRACTS.api.filter((r) => r.secret)) {
    assert.ok(rule.name in env, `${rule.name} is missing from the file`);
    const empty = env[rule.name] === "";
    const rejected = new RegExp(rule.name).test(reported);
    assert.ok(
      empty || rejected,
      `${rule.name} carries a value production would accept — it must not`,
    );
  }

  // And no secret's value is echoed while being reported.
  assert.ok(!reported.includes("dev-secret-change-me"), reported);
});

test("docker/dev.env overrides only the hostnames", () => {
  // Compose applies env_file entries in order, so this one wins over
  // .env.example. Anything extra in here silently changes the dev stack.
  const docker = readFileSync(resolve("docker/dev.env"), "utf8");
  const names = [...docker.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

  assert.deepEqual(names.sort(), [
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
    "POSTGRES_USER",
    "REDIS_URL",
  ]);

  // Service names, not localhost — a container cannot reach the host's.
  assert.match(docker, /@postgres:/);
  assert.match(docker, /redis:\/\/redis:/);
  const values = [...docker.matchAll(/^[A-Z][A-Z0-9_]*="?([^"\n]*)"?$/gm)].map(
    (m) => m[1],
  );
  for (const value of values) {
    assert.ok(!value.includes("localhost"), `points at localhost: ${value}`);
  }
});

test("every generated file is tracked by git", () => {
  // Each one sits behind a broad ignore rule, and each needed its own way
  // past it:
  //   apps/api/.env.example   apps/api/.gitignore ignores `.env` only
  //   apps/web/.env.example   apps/web/.gitignore has `.env*`, so it needs
  //                           an explicit `!.env.example` negation
  //   docker/dev.env          the root `.env` rule would swallow `docker/.env`,
  //                           which is why this one is not named that
  //
  // An untracked file here fails silently: compose cannot read it and CI's
  // --check reports it missing on a fresh clone while it works locally.
  //
  // `git ls-files` rather than `check-ignore`, which exits 0 for a NEGATION
  // match too and would call an un-ignored file ignored.
  for (const path of GENERATED) {
    const tracked = execFileSync("git", ["ls-files", "--", path], {
      cwd: resolve("."),
      encoding: "utf8",
    }).trim();
    assert.equal(tracked, path, `${path} is not tracked by git`);
  }
});

test("variables whose danger is in setting them carry a CAUTION", () => {
  // Generating these files replaced hand-written prose with the contract's
  // one-line `why`, and two warnings went with it: that enabling proxy-header
  // trust asserts the origin refuses non-proxied traffic, and that filling in
  // REDIS_URL here breaks every CI job. Both are about the ACT of setting the
  // variable, which no `why` or `emptyMeans` covers.
  //
  // Listed explicitly rather than derived: this is the set someone can only
  // decide deliberately, so a new entry should be a deliberate edit here too.
  const MUST_WARN = ["INQUIRY_TRUST_PROXY_HEADERS", "REDIS_URL"];

  const text = readFileSync(resolve("apps/api/.env.example"), "utf8");
  for (const name of MUST_WARN) {
    const rule = CONTRACTS.api.find((r) => r.name === name);
    assert.ok(rule, `${name} is no longer in the contract`);
    assert.ok(rule.caution, `${name} must carry a caution`);

    // And it has to reach the file, which is where an operator reads it.
    const block = text.slice(0, text.indexOf(`\n${name}=`));
    const lastBreak = block.lastIndexOf("\n\n");
    assert.match(
      block.slice(lastBreak),
      /CAUTION:/,
      `${name}'s caution did not reach .env.example`,
    );
  }
});

test("an unknown option is refused, not treated as write mode", () => {
  // The two modes do opposite things, so a typo is the dangerous case:
  // `--chek` would fall through to writing, rewrite every file and exit 0,
  // telling someone who meant to verify that they had — after overwriting
  // the evidence. Exit 2 for usage, distinct from 1 for a stale file.
  for (const bad of ["--chek", "--dry-run", "-c", "check"]) {
    const { status, out } = run([bad]);
    assert.equal(status, 2, `${bad} should be a usage error: ${out}`);
    assert.match(out, /Unknown option/);
  }

  // Both documented modes still work.
  assert.equal(run(["--check"]).status, 0);
  assert.equal(run([]).status, 0);
});
