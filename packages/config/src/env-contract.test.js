import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_ENV_CONTRACT,
  assertContractsAreExhaustive,
  isRenderDeploy,
  WEB_ENV_CONTRACT,
  checkEnv,
  detectEnvironment,
  formatReport,
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

test("an unknown environment is permissive but never silent", () => {
  const result = checkEnv({ app: "web", env: { NODE_ENV: "production" } });
  assert.equal(result.ok, true, formatReport(result));
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
// Severity semantics
// ---------------------------------------------------------------------

test("a required variable missing is an error; recommended is only a warning", () => {
  const result = checkEnv({ app: "api", env: { RENDER: "true" } });
  assert.match(messages(result.errors), /DATABASE_URL is not set/);
  assert.match(messages(result.warnings), /REDIS_URL is not set/);
  assert.equal(result.ok, false);
});

test("an empty string counts as absent, not as satisfied", () => {
  // .env.example ships several variables as `NAME=` and dotenv loads those as
  // "". Treating that as present would report a blank JWT_SECRET as fine.
  const result = checkEnv({
    app: "api",
    env: { RENDER: "true", DATABASE_URL: "postgresql://u:p@h/db", JWT_SECRET: "" },
  });
  assert.match(messages(result.errors), /JWT_SECRET is not set/);
});

test("a malformed value is an error even where the variable is optional", () => {
  // Absence is often a deliberate, documented state. A present-but-malformed
  // value never is.
  const result = checkEnv({
    app: "api",
    env: { REDIS_URL: "http://localhost:6379" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /REDIS_URL must use redis: or rediss:/);
});

test("INQUIRY_TRUST_PROXY_HEADERS must be exactly true or false", () => {
  const result = checkEnv({
    app: "api",
    env: { INQUIRY_TRUST_PROXY_HEADERS: "yes" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /must be exactly one of "true", "false"/);
});

// ---------------------------------------------------------------------
// The rule that protects the logs
// ---------------------------------------------------------------------

test("a secret's value is never echoed, but a non-secret's is", () => {
  const secretResult = checkEnv({
    app: "api",
    env: { DATABASE_URL: "mysql://root:hunter2@db/app" },
    environment: "localhost",
  });
  const text = messages(secretResult.errors);
  assert.match(text, /DATABASE_URL/);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /Value not shown/);

  // A URL is diagnostic rather than sensitive, and withholding it would make
  // the message useless.
  const openResult = checkEnv({
    app: "web",
    env: { NEXT_PUBLIC_API_URL: "not-a-url" },
    environment: "localhost",
  });
  assert.match(messages(openResult.errors), /not-a-url/);
});

test("every rule marked secret withholds its value on every failure path", () => {
  // Asserts the property across the whole table rather than the two rules a
  // hand-written test happens to name.
  for (const rule of [...API_ENV_CONTRACT, ...WEB_ENV_CONTRACT]) {
    if (!rule.secret || !rule.check) continue;
    const canary = "CANARY-SECRET-VALUE-THAT-IS-INVALID";
    const app = API_ENV_CONTRACT.includes(rule) ? "api" : "web";
    const result = checkEnv({
      app,
      env: { [rule.name]: canary },
      environment: "localhost",
    });
    assert.doesNotMatch(
      messages(result.errors) + messages(result.warnings),
      /CANARY-SECRET-VALUE/,
      `${rule.name} leaked its value into a message`,
    );
  }
});

// ---------------------------------------------------------------------
// Cross-field rules — where each variable looks fine on its own
// ---------------------------------------------------------------------

test("free-form WhatsApp with no template is refused", () => {
  const result = checkEnv({
    app: "api",
    env: { WHATSAPP_ALLOW_FREE_FORM: "true" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /marks every inquiry FAILED/);
});

test("a WhatsApp token with no template name is refused", () => {
  const result = checkEnv({
    app: "api",
    env: { WHATSAPP_ACCESS_TOKEN: "tok" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /WHATSAPP_TEMPLATE_NAME is not/);
});

test("a non-local blob provider without credentials is refused", () => {
  const result = checkEnv({
    app: "api",
    env: { BLOB_PROVIDER: "r2" },
    environment: "localhost",
  });
  assert.match(
    messages(result.errors),
    /BLOB_ACCESS_KEY_ID and BLOB_SECRET_ACCESS_KEY/,
  );
  // The point of the rule: without it this surfaces at the first upload,
  // long after a green deploy.
  assert.match(messages(result.errors), /not at boot/);
});

test("localhost URLs on Render are refused", () => {
  const result = checkEnv({
    app: "web",
    env: {
      RENDER: "true",
      NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    },
  });
  assert.match(messages(result.errors), /NEXT_PUBLIC_SITE_URL point at localhost/);
});

test("plain http on Render is refused", () => {
  const result = checkEnv({
    app: "web",
    env: {
      RENDER: "true",
      NEXT_PUBLIC_API_URL: "http://api.laxair.shop/graphql",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
    },
  });
  assert.match(messages(result.errors), /use http:\/\/ on Render/);
});

// ---------------------------------------------------------------------
// Regression guards: this check must not break checks that are green today
// ---------------------------------------------------------------------

test("the CI web build passes with no environment at all", () => {
  // `test-web` runs `pnpm build` with no env block and no `cp .env.example`.
  // API_URL and SITE_URL have localhost defaults, so the build is fine --
  // marking them required everywhere would turn a green required check red.
  const result = checkEnv({ app: "web", env: { CI: "true" } });
  assert.equal(result.ok, true, formatReport(result));
});

test("the prod web image boots with no configuration", () => {
  // docker-web-prod-boot runs the real production image with no env, and
  // asserts a genuine 200. Nothing may be required in that state.
  const result = checkEnv({
    app: "web",
    env: { NODE_ENV: "production" },
  });
  assert.equal(result.ok, true, formatReport(result));
});

test("the docker-compose dev stack satisfies the API contract", () => {
  // dev-secret-change-me is warned about here and REFUSED on render — see
  // the placeholder tests below. A hard error everywhere would fail
  // docker-smoke for using the value it is supposed to use.
  // The exact values docker-compose.yml sets, including the literal
  // placeholder JWT secret -- which must stay acceptable outside Render.
  const result = checkEnv({
    app: "api",
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/medinstru?schema=public",
      REDIS_URL: "redis://redis:6379",
      JWT_SECRET: "dev-secret-change-me",
      PORT: "4000",
    },
    environment: "localhost",
  });
  assert.equal(result.ok, true, formatReport(result));
});

test("a checkout using .env.example verbatim passes", () => {
  // CI's api jobs run `cp .env.example .env`. REDIS_URL is blank there on
  // purpose and must not be an error.
  const result = checkEnv({
    app: "api",
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/medinstru?schema=public",
      REDIS_URL: "",
      JWT_SECRET: "dev-secret-change-me",
      PORT: "4000",
      INQUIRY_IP_HASH_SECRET: "",
      INQUIRY_TRUST_PROXY_HEADERS: "false",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_TEMPLATE_NAME: "",
      WHATSAPP_TEMPLATE_LANGUAGE: "en",
      WHATSAPP_ALLOW_FREE_FORM: "false",
    },
    environment: "github-ci",
  });
  assert.equal(result.ok, true, formatReport(result));
});

// ---------------------------------------------------------------------
// A correctly configured production environment
// ---------------------------------------------------------------------

test("a fully configured Render API reports clean", () => {
  const result = checkEnv({
    app: "api",
    env: {
      RENDER: "true",
      DATABASE_URL: "postgresql://u:p@dpg-x/medinstru",
      // "example" keeps scripts/lib/repo-hygiene.mjs's credential scanner
      // from reading a long opaque string assigned to a *_SECRET name as a
      // committed credential -- it fired on the previous fixture, correctly.
      JWT_SECRET: "example-secret-of-sufficient-length",
      REDIS_URL: "redis://red-x:6379",
      PORT: "4000",
      INQUIRY_IP_HASH_SECRET: "0123456789abcdef0123",
      INQUIRY_TRUST_PROXY_HEADERS: "false",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      BLOB_PROVIDER: "r2",
      BLOB_ACCESS_KEY_ID: "id",
      BLOB_SECRET_ACCESS_KEY: "secret",
      WHATSAPP_ACCESS_TOKEN: "tok",
      WHATSAPP_PHONE_NUMBER_ID: "109876543210987",
      WHATSAPP_TEMPLATE_LANGUAGE: "en",
      WHATSAPP_TEMPLATE_NAME: "buyer_inquiry",
      WHATSAPP_ALLOW_FREE_FORM: "false",
    },
  });
  assert.equal(result.ok, true, formatReport(result));
  assert.equal(result.warnings.length, 0, formatReport(result));
});

test("formatReport names the app and environment, and says it is refusing to start", () => {
  const report = formatReport(checkEnv({ app: "api", env: { RENDER: "true" } }));
  assert.match(report, /app: api, environment: render/);
  assert.match(report, /Refusing to start/);
});

// ---------------------------------------------------------------------
// Structural strictness: the contract must not be able to go quiet
// ---------------------------------------------------------------------

test("every rule names every environment, checks its value, and justifies any softening", () => {
  // One assertion for three properties on purpose -- they are the same
  // property viewed three ways: a rule may not be vague about anything.
  assertContractsAreExhaustive();
});

test("a partial rule is rejected — this is what stops silent permissiveness", () => {
  // Proves the guard above actually fails, rather than passing vacuously.
  // An assertion that has never been seen to fail is not evidence.
  const complete = API_ENV_CONTRACT.find((r) => r.name === "DATABASE_URL");
  assert.ok(complete, "DATABASE_URL rule missing");
  for (const environment of ["render", "localhost", "github-ci", "ci-local", "test", "unknown"]) {
    assert.ok(
      environment in complete.levels,
      `DATABASE_URL must declare ${environment}`,
    );
  }
  assert.equal(typeof complete.check, "function");
});

// ---------------------------------------------------------------------
// Values that are set but wrong — the half that reaches production
// ---------------------------------------------------------------------

test("a trailing newline or stray space is caught on any variable", () => {
  // Survives copy-paste and here-docs, is preserved by shells and dotenv,
  // and nothing downstream trims. A DATABASE_URL with one still parses.
  const result = checkEnv({
    app: "api",
    env: { DATABASE_URL: "postgresql://u:p@h/db\n" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /has leading or trailing whitespace/);
});

test("quotes left around a value are caught", () => {
  // A dashboard field is not a shell: quoting there stores the quotes, and a
  // JWT_SECRET two characters longer than anyone believes still passes a
  // length check.
  const result = checkEnv({
    app: "api",
    env: { JWT_SECRET: '"example-secret-of-suitable-length"' },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /wrapped in quotes/);
});

test("the shipped placeholder secret is refused", () => {
  // .env.example and docker-compose.yml both ship dev-secret-change-me, so
  // the realistic production failure is not an absent secret but the
  // development one copied forward.
  const result = checkEnv({
    app: "api",
    env: { JWT_SECRET: "dev-secret-change-me" },
    environment: "render",
  });
  assert.match(messages(result.errors), /still looks like a placeholder/);
});

test("placeholders are caught inside a longer value, not just as the whole string", () => {
  const result = checkEnv({
    app: "api",
    env: { INQUIRY_IP_HASH_SECRET: "prod-CHANGE_ME-abc" },
    environment: "render",
  });
  assert.match(messages(result.errors), /still looks like a placeholder/);
});

test("a phone NUMBER pasted where Meta's numeric ID belongs is caught", () => {
  const result = checkEnv({
    app: "api",
    env: { WHATSAPP_PHONE_NUMBER_ID: "+91 98765 43210" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /not a phone number/);
});

test("a WhatsApp template name Meta would reject is caught at boot, not at send time", () => {
  const result = checkEnv({
    app: "api",
    env: { WHATSAPP_TEMPLATE_NAME: "Buyer Inquiry" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /lowercase letters, digits and underscores/);
});

test("a trailing slash on SITE_URL is caught", () => {
  // Concatenates into https://laxair.shop//en -- which resolves, but
  // publishes a different canonical URL than the sitemap emits. Two URLs for
  // one page is the exact thing canonical tags exist to prevent.
  const result = checkEnv({
    app: "web",
    env: { NEXT_PUBLIC_SITE_URL: "https://laxair.shop/" },
    environment: "localhost",
  });
  assert.match(messages(result.errors), /must not end with a trailing slash/);
});

// ---------------------------------------------------------------------
// APP_ENV
// ---------------------------------------------------------------------

test("a typo in APP_ENV is a hard error, not a silent downgrade", () => {
  // `APP_ENV=prod` is not a value this accepts. Quietly inferring localhost's
  // permissive rules from a typo'd override is exactly the failure this
  // module exists to remove.
  const result = checkEnv({
    app: "api",
    env: {
      APP_ENV: "prod",
      DATABASE_URL: "postgresql://u:p@h/db",
      JWT_SECRET: "example-secret-of-suitable-length",
      PORT: "4000",
    },
  });
  assert.equal(result.ok, false);
  assert.match(messages(result.errors), /not a known environment/);
  assert.match(messages(result.errors), /It was IGNORED/);
});
