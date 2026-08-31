import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_ENV_CONTRACT,
  DEPLOY_ENVIRONMENTS,
  WEB_ENV_CONTRACT,
  checkEnv,
  detectEnvironment,
  displayValue,
  expectationsFor,
  formatMatrix,
  formatReport,
  formatStartupBanner,
  isRenderDeploy,
} from "./env-contract.js";

const messages = (findings) => findings.map((f) => f.message).join("\n");

// ---------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------

test("detects Render, and Render wins over everything", () => {
  assert.equal(detectEnvironment({ RENDER: "true" }), "render");
  // Render does not set CI, but if anything ever does, production rules must
  // not be downgraded to CI's permissive ones.
  assert.equal(
    detectEnvironment({ RENDER: "true", CI: "true", NODE_ENV: "test" }),
    "render",
  );
});

test("RENDER_GIT_COMMIT alone marks a Render deploy — that is the build-time signal", () => {
  // Render hands a Docker BUILD nothing unless the Dockerfile declares an ARG
  // for it, and apps/web/Dockerfile declares one for RENDER_GIT_COMMIT but
  // not for RENDER. So during the image build this is the only signal there
  // is -- and it is the one that matters, because NEXT_PUBLIC_* values are
  // inlined into the client bundle at build time.
  assert.equal(isRenderDeploy({ RENDER_GIT_COMMIT: "abc123" }), true);
  assert.equal(detectEnvironment({ RENDER_GIT_COMMIT: "abc123" }), "render");

  // Empty is not a deploy: the Dockerfile's ARG defaults to "".
  assert.equal(isRenderDeploy({ RENDER_GIT_COMMIT: "" }), false);
  assert.equal(isRenderDeploy({}), false);
});

test("neither Render signal is set by CI or by a developer machine", () => {
  // docker-web-prod-boot runs `docker build --target prod` with no build args
  // and `docker run` with no environment, on purpose -- proving the image
  // boots unconfigured. Verified by reading ci.yml, not assumed.
  assert.equal(isRenderDeploy({ CI: "true", GITHUB_ACTIONS: "true" }), false);
  assert.equal(isRenderDeploy({ HOME: "/Users/someone" }), false);
  assert.equal(isRenderDeploy({ NODE_ENV: "production" }), false);
});

test("a test run inside CI is 'test', not 'ci'", () => {
  // Both are true simultaneously on every GitHub Actions test job. The suites
  // supply their own fixtures, so test rules must win.
  assert.equal(detectEnvironment({ CI: "true", NODE_ENV: "test" }), "test");
  assert.equal(detectEnvironment({ CI: "true", VITEST: "true" }), "test");
  assert.equal(detectEnvironment({ CI: "true", JEST_WORKER_ID: "1" }), "test");
});

test("a bare process is localhost; a production one with no platform is unknown", () => {
  assert.equal(detectEnvironment({}), "localhost");
  assert.equal(detectEnvironment({ NODE_ENV: "development" }), "localhost");

  // NODE_ENV=production with no recognised platform is NOT silently folded
  // into localhost. The prod Docker image sets it wherever it is built --
  // including docker-web-prod-boot, which boots it with no configuration on
  // purpose -- so this must stay permissive, but it must also say so.
  assert.equal(detectEnvironment({ NODE_ENV: "production" }), "unknown");
});

test("an unknown environment is still held to the full contract", () => {
  // "unknown" used to be permissive -- nothing required, just a warning. Under
  // one shared variable list there is nothing left to be permissive ABOUT: an
  // unrecognised environment declares the same variables as every other one.
  // What survives is the warning, because "we could not tell where we are" is
  // still worth saying out loud.
  const result = checkEnv({ app: "web", env: { NODE_ENV: "production" } });
  assert.equal(result.ok, false);
  assert.match(messages(result.errors), /NEXT_PUBLIC_API_URL is not declared/);
  assert.match(messages(result.warnings), /Environment not recognised/);
  assert.match(messages(result.warnings), /set APP_ENV/);
});

test("APP_ENV overrides inference outright", () => {
  // Inference is a heuristic over variables other people set for their own
  // reasons. An operator who states the answer must not be second-guessed --
  // and this is the escape hatch for any host detection has never heard of.
  assert.equal(detectEnvironment({ APP_ENV: "render" }), "render");
  assert.equal(
    detectEnvironment({ APP_ENV: "localhost", RENDER: "true" }),
    "localhost",
  );
  // A value that is not a known environment is ignored rather than trusted.
  assert.equal(detectEnvironment({ APP_ENV: "staging-2" }), "localhost");
});

test("GitHub Actions and a local CI run are told apart", () => {
  // GitHub sets CI too, so checking CI first would swallow every GitHub run.
  assert.equal(
    detectEnvironment({ CI: "true", GITHUB_ACTIONS: "true" }),
    "github-ci",
  );
  // `CI=true pnpm install` on a Mac, or another CI provider.
  assert.equal(detectEnvironment({ CI: "true" }), "ci-local");
});

// ---------------------------------------------------------------------
// The model: same variables everywhere, values differ
// ---------------------------------------------------------------------

/** A complete, valid environment, so a case can change exactly one thing. */
const completeApi = {
  APP_ENV: "localhost",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/medinstru",
  JWT_SECRET: "example-secret-of-suitable-length",
  PORT: "4000",
  REDIS_URL: "",
  INQUIRY_IP_HASH_SECRET: "",
  INQUIRY_TRUST_PROXY_HEADERS: "false",
  BLOB_PROVIDER: "local",
  BLOB_ACCESS_KEY_ID: "",
  BLOB_SECRET_ACCESS_KEY: "",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  WHATSAPP_ACCESS_TOKEN: "",
  WHATSAPP_PHONE_NUMBER_ID: "",
  WHATSAPP_TEMPLATE_NAME: "",
  WHATSAPP_TEMPLATE_LANGUAGE: "",
  WHATSAPP_ALLOW_FREE_FORM: "false",
};

const completeWeb = {
  APP_ENV: "localhost",
  NEXT_PUBLIC_API_URL: "http://localhost:4000/graphql",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_BLOB_BASE_URL: "",
  SOURCEMAP_SIGNING_KEY: "",
};

test("a complete environment passes", () => {
  const api = checkEnv({ app: "api", env: completeApi });
  assert.equal(api.ok, true, formatReport(api));
  const web = checkEnv({ app: "web", env: completeWeb });
  assert.equal(web.ok, true, formatReport(web));
});

test("EVERY variable is required in EVERY environment", () => {
  // The point of the model. A per-environment severity table let a variable be
  // "required on render, optional everywhere else", which means it is
  // invisible in the four environments where you would actually notice it
  // missing -- you find out on the deploy.
  for (const environment of DEPLOY_ENVIRONMENTS) {
    const result = checkEnv({ app: "web", env: { APP_ENV: environment }, environment });
    const missing = messages(result.errors);
    for (const rule of WEB_ENV_CONTRACT) {
      if (rule.name === "APP_ENV") continue;
      assert.match(
        missing,
        new RegExp(`${rule.name} is not declared`),
        `${rule.name} must be required in ${environment}`,
      );
    }
  }
});

test("ABSENT and EMPTY are different things", () => {
  // The distinction the whole model rests on. process.env gives undefined for
  // a variable nobody wrote down and "" for one written as `NAME=`, so
  // "deliberately off" and "forgotten" are actually distinguishable -- an
  // earlier version collapsed them and threw that signal away.
  const absent = { ...completeWeb };
  delete absent.NEXT_PUBLIC_BLOB_BASE_URL;
  const withAbsent = checkEnv({ app: "web", env: absent });
  assert.match(messages(withAbsent.errors), /NEXT_PUBLIC_BLOB_BASE_URL is not declared/);

  // Declared empty is a value, and a legal one for this variable.
  const withEmpty = checkEnv({ app: "web", env: completeWeb });
  assert.equal(withEmpty.ok, true, formatReport(withEmpty));
});

test("empty is refused where empty means nothing", () => {
  // A blank JWT_SECRET is not a decision anybody made on purpose.
  const result = checkEnv({ app: "api", env: { ...completeApi, JWT_SECRET: "" } });
  assert.match(messages(result.errors), /JWT_SECRET is declared but empty/);
});

test("the not-declared message says how to turn a variable off", () => {
  // Being told a variable is missing is only useful with the next step
  // attached, and for these the next step is often "set it to empty".
  const env = { ...completeApi };
  delete env.WHATSAPP_ACCESS_TOKEN;
  const result = checkEnv({ app: "api", env });
  assert.match(messages(result.errors), /Set it to empty \(WHATSAPP_ACCESS_TOKEN=\)/);
  assert.match(messages(result.errors), /WhatsApp delivery is off/);
});

// ---------------------------------------------------------------------
// Values differ by environment; variables do not
// ---------------------------------------------------------------------

test("a localhost URL is fine locally and refused in production", () => {
  // The same variable, the same everywhere -- only what counts as a valid
  // VALUE changes. That is the whole shape of the model.
  const local = checkEnv({ app: "web", env: completeWeb, environment: "localhost" });
  assert.equal(local.ok, true, formatReport(local));

  const deployed = checkEnv({ app: "web", env: completeWeb, environment: "render" });
  assert.match(messages(deployed.errors), /points at this machine/);
});

test("plain http is refused in production", () => {
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "http://laxair.shop", NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql" },
    environment: "render",
  });
  assert.match(messages(result.errors), /must use https:\/\//);
});

test("BLOB_PROVIDER=local is correct locally and refused in production", () => {
  const local = checkEnv({ app: "api", env: completeApi, environment: "localhost" });
  assert.equal(local.ok, true, formatReport(local));

  const deployed = checkEnv({ app: "api", env: completeApi, environment: "render" });
  assert.match(messages(deployed.errors), /must not be `local` in production/);
});

// ---------------------------------------------------------------------
// Values that are set but wrong
// ---------------------------------------------------------------------

test("a trailing newline or stray space is caught on any variable", () => {
  const result = checkEnv({
    app: "api",
    env: { ...completeApi, DATABASE_URL: "postgresql://u:p@h/db\n" },
  });
  assert.match(messages(result.errors), /has leading or trailing whitespace/);
});

test("quotes left around a value are caught", () => {
  // A dashboard field is not a shell: quoting there stores the quotes, and a
  // JWT_SECRET two characters longer than anyone believes still passes a
  // length check.
  const result = checkEnv({
    app: "api",
    env: { ...completeApi, JWT_SECRET: '"example-secret-of-suitable-length"' },
  });
  assert.match(messages(result.errors), /wrapped in quotes/);
});

test("the shipped placeholder secret warns locally and is refused in production", () => {
  // docker-compose.yml ships dev-secret-change-me deliberately, so a hard
  // error everywhere would fail docker-smoke for using the value it is
  // supposed to use.
  const env = { ...completeApi, JWT_SECRET: "dev-secret-change-me" };
  const local = checkEnv({ app: "api", env, environment: "localhost" });
  assert.equal(local.ok, true, formatReport(local));
  assert.match(messages(local.warnings), /still looks like a placeholder/);

  const deployed = checkEnv({ app: "api", env, environment: "render" });
  assert.match(messages(deployed.errors), /is still a placeholder/);
});

test("a phone NUMBER pasted where Meta's numeric ID belongs is caught", () => {
  const result = checkEnv({
    app: "api",
    env: { ...completeApi, WHATSAPP_PHONE_NUMBER_ID: "+91 98765 43210" },
  });
  assert.match(messages(result.errors), /not a phone number/);
});

test("a trailing slash on SITE_URL is caught", () => {
  // Concatenates into https://laxair.shop//en -- which resolves, but
  // publishes a different canonical URL than the sitemap emits. Two URLs for
  // one page is exactly what canonical tags exist to prevent.
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "http://localhost:3000/" },
  });
  assert.match(messages(result.errors), /must not end with a trailing slash/);
});

// ---------------------------------------------------------------------
// Secrets never reach a log
// ---------------------------------------------------------------------

test("a secret's value is never echoed, but a non-secret's is", () => {
  const secret = checkEnv({
    app: "api",
    env: { ...completeApi, DATABASE_URL: "mysql://root:hunter2@db/app" },
  });
  const text = messages(secret.errors);
  assert.match(text, /DATABASE_URL/);
  assert.doesNotMatch(text, /hunter2/);

  // A URL is diagnostic rather than sensitive, and withholding it would make
  // the message useless.
  const open = checkEnv({ app: "web", env: { ...completeWeb, NEXT_PUBLIC_API_URL: "not-a-url" } });
  assert.match(messages(open.errors), /not-a-url/);
});

test("every secret rule withholds its value on every failure path", () => {
  // Asserts the property across the whole table rather than the two rules a
  // hand-written test happens to name.
  for (const [app, rules] of [["api", API_ENV_CONTRACT], ["web", WEB_ENV_CONTRACT]]) {
    const base = app === "api" ? completeApi : completeWeb;
    for (const rule of rules) {
      if (!rule.secret) continue;
      const canary = "CANARY-VALUE-THAT-IS-INVALID";
      const result = checkEnv({ app, env: { ...base, [rule.name]: canary } });
      assert.doesNotMatch(
        messages(result.errors) + messages(result.warnings),
        /CANARY-VALUE/,
        `${rule.name} leaked its value into a message`,
      );
    }
  }
});

// ---------------------------------------------------------------------
// The startup banner
// ---------------------------------------------------------------------

test("the banner shows every variable, masks secrets, and closes its box", () => {
  const result = checkEnv({ app: "web", env: completeWeb });
  const banner = formatStartupBanner(result, {
    ...completeWeb,
    SOURCEMAP_SIGNING_KEY: "k".repeat(43),
  });

  for (const rule of WEB_ENV_CONTRACT) assert.match(banner, new RegExp(rule.name));
  assert.match(banner, /environment: localhost/);

  // Masked, with a length -- a wrong-length secret is a real and common
  // misconfiguration, and a length on its own reveals nothing usable.
  assert.match(banner, /\*\*\* \(43 chars\)/);
  assert.doesNotMatch(banner, /kkkk/);

  // Every line the same width, or the box does not close -- which reads as a
  // rendering bug and undermines the one job a banner has.
  const lines = banner.split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `banner lines are ragged: ${[...widths].join(", ")}`);
});

test("a secret is never shown even partially", () => {
  // A masked prefix looks helpful and is not: it narrows a brute-force, and
  // it is exactly the kind of thing that gets pasted into a bug report.
  const rule = API_ENV_CONTRACT.find((r) => r.name === "JWT_SECRET");
  const shown = displayValue(rule, "super-secret-value-here");
  assert.doesNotMatch(shown, /super|secret-value/);
  assert.match(shown, /^\*\*\*/);
});

test("the banner distinguishes not-declared from empty", () => {
  const rule = WEB_ENV_CONTRACT.find((r) => r.name === "NEXT_PUBLIC_BLOB_BASE_URL");
  assert.equal(displayValue(rule, undefined), "(not declared)");
  assert.equal(displayValue(rule, ""), "(empty)");
});

// ---------------------------------------------------------------------
// Seeing the contract
// ---------------------------------------------------------------------

test("the matrix lists every variable exactly once", () => {
  const matrix = formatMatrix("api");
  for (const rule of API_ENV_CONTRACT) {
    const occurrences = matrix.split("\n").filter((l) => l.startsWith(rule.name));
    assert.equal(occurrences.length, 1, `${rule.name} should appear once`);
  }
});

test("expectationsFor describes an environment without a second table", () => {
  // Derived from the rules, never maintained alongside them -- a hand-written
  // summary drifts from what it summarises, silently.
  const render = expectationsFor("api", "render");
  assert.deepEqual(render.declared, API_ENV_CONTRACT.map((r) => r.name));
  assert.ok(render.extraValueRules.includes("BLOB_PROVIDER"));

  const localhost = expectationsFor("api", "localhost");
  assert.deepEqual(localhost.declared, render.declared, "the variable list never changes");
  assert.equal(localhost.extraValueRules.length, 0, "only the value rules differ");
});

// ---------------------------------------------------------------------
// APP_ENV
// ---------------------------------------------------------------------

test("a typo in APP_ENV is a hard error, not a silent downgrade", () => {
  const result = checkEnv({ app: "web", env: { ...completeWeb, APP_ENV: "prod" } });
  assert.equal(result.ok, false);
  assert.match(messages(result.errors), /not a known environment/);
});

test("angle-bracket placeholders are caught without a quadratic regex", () => {
  // CodeQL flagged the previous `<[^>]+>` alternative as js/polynomial-redos
  // (high): unanchored, the engine retries `[^>]+` from every `<`, so
  // "<<<<<<<<..." is quadratic. Two index lookups answer the same question.
  const caught = checkEnv({
    app: "api",
    env: { ...completeApi, JWT_SECRET: "<your-key-here-padded>" },
    environment: "render",
  });
  assert.match(messages(caught.errors), /is still a placeholder/);

  // The shape that was slow. A regression would not fail this assertion, it
  // would fail to finish -- which the runner reports as a timeout, and is the
  // only honest way to assert "linear".
  const start = Date.now();
  checkEnv({
    app: "api",
    env: { ...completeApi, JWT_SECRET: "<".repeat(200_000) },
    environment: "render",
  });
  assert.ok(
    Date.now() - start < 1000,
    "placeholder detection should be linear in the value's length",
  );
});
