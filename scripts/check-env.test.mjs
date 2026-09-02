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

const CLI = fileURLToPath(new URL("./check-env.mjs", import.meta.url));

/** @returns {{status: number, out: string}} */
function run(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
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

test("the CLI reads each app's own .env and passes on this repo", () => {
  // The whole reason readAppEnv exists: without it every variable comes back
  // "not declared" on a correctly configured laptop, which trains people to
  // ignore the check.
  const { status, out } = run(["all"]);
  assert.equal(status, 0, out);
  assert.match(out, /app: api/);
  assert.match(out, /app: web/);
  assert.ok(!out.includes("is not declared"), out);
});

test("an explicit variable wins over the .env file", () => {
  // process.loadEnvFile never overwrites an already-set value, and the CLI
  // depends on that: `FOO=bar node scripts/check-env.mjs` must check `bar`.
  // apps/api/.env ships a placeholder JWT_SECRET, so the warning it produces
  // is the observable difference.
  const withFile = run(["api"]);
  assert.match(withFile.out, /JWT_SECRET still looks like a placeholder/);

  const overridden = run(["api"], {
    JWT_SECRET: "an-ordinary-value-of-sufficient-length", // scan-ignore
  });
  assert.equal(overridden.status, 0, overridden.out);
  assert.ok(
    !overridden.out.includes("JWT_SECRET still looks like a placeholder"),
    overridden.out,
  );
});

test("one app's values do not leak into the other's report", () => {
  // readAppEnv mutates process.env and restores it, so `all` must produce
  // exactly the same web verdict as `web` alone. Without the restore the
  // API's values are still present when the web app is checked.
  const both = run(["all"]);
  const webOnly = run(["web"]);
  const webSection = both.out.slice(both.out.indexOf("app: web"));
  assert.equal(
    webSection.includes("ERROR"),
    webOnly.out.includes("ERROR"),
    `all:\n${both.out}\nweb:\n${webOnly.out}`,
  );
});

test("a missing variable exits 1 and names it", () => {
  // Only reachable by forcing a target whose rules this machine cannot meet;
  // the repo's own .env is valid, which is what the first test asserts.
  const { status, out } = run(["api", "--env", "render"]);
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
  const { out } = run(["api", "--env", "render"]);
  assert.match(out, /APP_ENV/);
  assert.match(out, /must itself be "render"/);
});

test("--list prints the contract without needing a valid environment", () => {
  const { status, out } = run(["api", "--list"], { JWT_SECRET: "" });
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
  const { status, out } = run(["web", "--env", "render"]);
  assert.equal(status, 1, out);
  assert.match(out, /environment: render/);
  // A missing .env.production is not an error — absent is a legal state.
  assert.ok(!out.includes("Could not read"), out);
});
