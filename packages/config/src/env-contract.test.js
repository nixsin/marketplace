import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_ENV_CONTRACT,
  DEPLOY_ENVIRONMENTS,
  WEB_ENV_CONTRACT,
  checkEnv,
  detectEnvironment,
  displaySafe,
  displayValue,
  expectationsFor,
  formatMatrix,
  formatReport,
  formatStartupBanner,
  isDeployedEnvironment,
  isRenderDeploy,
  redactUrlCredentials,
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

test("APP_ENV narrows inference, but never downgrades a platform marker", () => {
  // It CAN state an environment nothing can detect.
  assert.equal(detectEnvironment({ APP_ENV: "render" }), "render");
  assert.equal(detectEnvironment({ APP_ENV: "ci-local" }), "ci-local");

  // It CANNOT talk the checker out of a marker the platform injected. That
  // ordering was the other way round, and one leftover `APP_ENV=localhost`
  // silently disabled every render-only rule -- including the refusal of the
  // development JWT_SECRET and of an empty INQUIRY_IP_HASH_SECRET.
  assert.equal(
    detectEnvironment({ APP_ENV: "localhost", RENDER: "true" }),
    "render",
  );

  // And the contradiction is reported rather than silently resolved: anything
  // reading APP_ENV is being misled.
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, APP_ENV: "localhost", RENDER: "true" },
  });
  assert.match(messages(result.errors), /the platform wins/i);

  // A value that is not a known environment is still ignored for detection.
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

// The same variables with values production accepts. Built once here rather
// than inline per test, because "what does a valid Render API environment
// look like" is exactly the question this contract exists to answer, and a
// test that spells it out is also the readable example.
const completeApiRender = {
  ...completeApi,
  APP_ENV: "render",
  DATABASE_URL: "postgresql://u:p@dpg-abc123-a.oregon-postgres.render.com:5432/db",
  // Both carry a scan-ignore marker, and the conflict is inherent rather
  // than a scanner quirk: production REFUSES any value matching a
  // placeholder term, so a fixture that satisfies the production rules must
  // by construction look like a real secret to a credential scanner. These
  // two are invented, are used only by this file, and open nothing.
  JWT_SECRET: "unremarkable-but-long-enough-string", // scan-ignore
  INQUIRY_IP_HASH_SECRET: "another-unremarkable-long-string", // scan-ignore
  BLOB_PROVIDER: "s3",
  BLOB_ACCESS_KEY_ID: "an-access-key-id",
  BLOB_SECRET_ACCESS_KEY: "an-access-key-secret", // scan-ignore
  NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
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
  assert.match(messages(deployed.errors), /must be a public DNS name/);
});

test("plain http is refused in production", () => {
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "http://laxair.shop", NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql" },
    environment: "render",
  });
  assert.match(messages(result.errors), /must use https:\/\//);
});

test("BLOB_PROVIDER=local is allowed everywhere — the WRITE path refuses it", () => {
  // Deliberately NOT refused here, and the reasoning is worth keeping.
  //
  // The invariant is "never write data to storage the CDN does not serve",
  // which `local` violates only when something WRITES. Nothing in this app
  // injects BLOB_STORE yet, so refusing at boot would block a deploy over a
  // capability with zero call sites -- and an error that cannot yet be true
  // is the kind people learn to route around.
  //
  // createBlobStore() passes a refusal reason to LocalBlobStore on a
  // deployment, so the first upload in production throws naming
  // BLOB_PROVIDER. See blob-store.spec.ts. The value is still reported on
  // every boot by the startup banner, so it is visible without being fatal.
  const local = checkEnv({ app: "api", env: completeApi, environment: "localhost" });
  assert.equal(local.ok, true, formatReport(local));

  // Production-shaped values, since localhost URLs are refused on render for
  // their own (correct) reasons -- this case is about BLOB_PROVIDER alone.
  const deployed = checkEnv({
    app: "api",
    env: {
      ...completeApi,
      APP_ENV: "render",
      DATABASE_URL: "postgresql://u:p@dpg-x.render.com/medinstru",
      JWT_SECRET: "example-secret-of-suitable-length",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      // Non-empty because production refuses an empty one: it is an abuse
      // control on an unauthenticated endpoint, and its absence is silent.
      INQUIRY_IP_HASH_SECRET: "0123456789abcdef0123",
      BLOB_PROVIDER: "local",
    },
    environment: "render",
  });
  assert.equal(deployed.ok, true, formatReport(deployed));

  // A value that is not a known provider is still an error everywhere.
  const bogus = checkEnv({
    app: "api",
    env: { ...completeApi, BLOB_PROVIDER: "dropbox" },
    environment: "render",
  });
  assert.match(messages(bogus.errors), /must be exactly one of/);
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
  assert.match(messages(deployed.errors), /looks like a placeholder/);
});

test("a phone NUMBER pasted where Meta's numeric ID belongs is caught", () => {
  const result = checkEnv({
    app: "api",
    env: { ...completeApi, WHATSAPP_PHONE_NUMBER_ID: "+91 98765 43210" },
  });
  assert.match(messages(result.errors), /not a phone number/);
});

test("SITE_URL must be a bare origin, since paths are appended to it", () => {
  // Concatenates into https://laxair.shop//en -- which resolves, but
  // publishes a different canonical URL than the sitemap emits. Two URLs for
  // one page is exactly what canonical tags exist to prevent.
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "http://localhost:3000/" },
  });
  assert.match(messages(result.errors), /must be a bare origin/);
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
  // DATABASE_URL gains a loopback check in production; the variable list
  // itself is identical everywhere.
  assert.ok(render.extraValueRules.includes("DATABASE_URL"));

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
  assert.match(messages(caught.errors), /looks like a placeholder/);

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

test("EVERY variable is checked for placeholders in production, not just a few", () => {
  // The generic check used to warn only when NOT on render, so production
  // fell through to whichever rules happened to list `notPlaceholder` --
  // exactly one of them. `WHATSAPP_ACCESS_TOKEN=change-me` sailed past.
  for (const name of [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_TEMPLATE_NAME",
    "BLOB_ACCESS_KEY_ID",
  ]) {
    const result = checkEnv({
      app: "api",
      env: { ...completeApi, [name]: "change-me-please" },
      environment: "render",
    });
    assert.match(
      messages(result.errors),
      new RegExp(`${name} still looks like a placeholder`),
      `${name} must be placeholder-checked in production`,
    );
  }
});

test("a forced --env target is not treated as a platform contradiction", () => {
  // `--env render` asks "would this pass there?" from a laptop, where
  // APP_ENV is legitimately localhost. Comparing a FORCED target against
  // APP_ENV reported a contradiction with no platform involved, and broke
  // the documented dry-run workflow.
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, APP_ENV: "localhost" },
    environment: "render",
  });
  assert.doesNotMatch(messages(result.errors), /the platform wins/i);
});

test("a malformed URL carrying credentials is still redacted", () => {
  // `https://user:secret@` fails to parse, so the URL-based redaction never
  // ran and the raw value was printed verbatim -- by the error text and by
  // the banner both.
  const env = { ...completeWeb, NEXT_PUBLIC_API_URL: "https://user:secret@" };
  const result = checkEnv({ app: "web", env, environment: "localhost" });
  const shown = formatReport(result) + formatStartupBanner(result, env);
  assert.doesNotMatch(shown, /secret@/);
  assert.match(shown, /redacted/);
});

test("APP_ENV=render engages the deployment write guard", () => {
  // isDeployedEnvironment() asked only about platform MARKERS, so a process
  // identified as production purely by APP_ENV still got LocalBlobStore's
  // write path enabled. Deployment-sensitive callers must agree with
  // detection, or "which environment am I" has two answers.
  assert.equal(isDeployedEnvironment({ APP_ENV: "render" }), true);
  assert.equal(isDeployedEnvironment({ RENDER: "true" }), true);
  assert.equal(isDeployedEnvironment({ RENDER_GIT_COMMIT: "abc" }), true);
  assert.equal(isDeployedEnvironment({ APP_ENV: "localhost" }), false);
  assert.equal(isDeployedEnvironment({}), false);
});

test("username-only userinfo is redacted too, not just user:password", () => {
  // The malformed-URL fallback required a colon, so a bare
  // `https://secret-token@` was printed verbatim by the error and the banner.
  const env = { ...completeWeb, NEXT_PUBLIC_API_URL: "https://secret-token@" };
  const result = checkEnv({ app: "web", env, environment: "localhost" });
  const shown = formatReport(result) + formatStartupBanner(result, env);
  assert.doesNotMatch(shown, /secret-token/);
  assert.match(shown, /redacted/);
});

test("redaction FAILS CLOSED on userinfo no pattern can describe", () => {
  // Two rounds went into widening a regex: it missed username-only userinfo,
  // then userinfo containing a slash. A pattern that must recognise every
  // malformed shape is the wrong tool -- the value is malformed precisely
  // because its structure is not knowable. Anything unparseable with an
  // authority-style `@` is now withheld entirely.
  for (const value of [
    "https://user:secret@",
    "https://secret-token@",
    "https://user:sec/ret@",
    "https://a:b@c:d@",
  ]) {
    const env = { ...completeWeb, NEXT_PUBLIC_API_URL: value };
    const result = checkEnv({ app: "web", env, environment: "localhost" });
    const shown = formatReport(result) + formatStartupBanner(result, env);
    assert.doesNotMatch(shown, /secret|token/, `leaked from ${value}`);
  }

  // A valid URL with no credentials is still shown in full: withholding it
  // would make the message useless for the common case.
  const fine = { ...completeWeb, NEXT_PUBLIC_API_URL: "https://ok.example.com/g" };
  const okResult = checkEnv({ app: "web", env: fine, environment: "localhost" });
  assert.match(formatStartupBanner(okResult, fine), /ok\.example\.com/);
});

test("an empty NEXT_PUBLIC_SITE_URL is refused for the API in production", () => {
  // `emptyMeans` says empty is legal SOMEWHERE, not everywhere. In production
  // the link is the difference between a seller clicking through and typing a
  // search, and inquiries.service.ts already claimed this rule existed.
  const result = checkEnv({
    app: "api",
    env: {
      ...completeApi,
      APP_ENV: "render",
      DATABASE_URL: "postgresql://u:p@dpg-x.render.com/db",
      JWT_SECRET: "example-secret-of-suitable-length",
      INQUIRY_IP_HASH_SECRET: "0123456789abcdef0123",
      NEXT_PUBLIC_SITE_URL: "",
    },
    environment: "render",
  });
  assert.match(messages(result.errors), /omit the product link/);
});

test("a localhost blob base URL is refused in production", () => {
  // This rule had only the scheme check, so `https://localhost:9000` passed
  // and every visitor's browser would fetch product images from their own
  // machine while the check reported success.
  const result = checkEnv({
    app: "web",
    env: {
      ...completeWeb,
      APP_ENV: "render",
      NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      NEXT_PUBLIC_BLOB_BASE_URL: "https://localhost:9000",
    },
    environment: "render",
  });
  assert.match(messages(result.errors), /must be a public DNS name/);
});

test("display is safe for every value, not just recognisable URLs", () => {
  // Three rounds went into widening a redaction pattern. The question is not
  // "does this look like userinfo" but "can I rule it out" -- so anything
  // unparseable containing `@` is withheld whole, with no `//` required.
  assert.match(displaySafe("not-a-url user:hunter2@"), /redacted/);
  assert.doesNotMatch(displaySafe("not-a-url user:hunter2@"), /hunter2/);

  // Control characters forge log lines and rewrite terminals. The banner
  // draws a box around these values, so a newline breaks it open. Same
  // reasoning as sanitizeForLog stripping \p{Cf} as well as \p{Cc}.
  assert.doesNotMatch(displaySafe("a\nFAKE: line"), /\n/);
  assert.doesNotMatch(displaySafe("a\u202Eb"), /\u202E/);
  assert.doesNotMatch(displaySafe("a\u001B[31mred"), /\u001B/);

  // An ordinary value is untouched: withholding everything would make the
  // banner useless for the common case.
  assert.equal(displaySafe("https://laxair.shop"), "https://laxair.shop");
});

test("public URLs must be NAMES, which rejects every IP literal at once", () => {
  // Not an IP-range check. Five review rounds went into enumerating IANA
  // special-purpose ranges before it became clear that a production URL is
  // always a DNS name -- an IP literal cannot get a certificate from the CDN
  // in front of it. One rule rejects both families and cannot go stale.
  for (const host of [
    "127.0.0.2",
    "10.0.0.5",
    "192.168.1.1",
    "100.64.0.1",
    "192.0.0.1",
    "[fec0::1]",
    "[2606:4700::1111]",
    "api",
    "localhost",
  ]) {
    const result = checkEnv({
      app: "web",
      env: {
        ...completeWeb,
        APP_ENV: "render",
        NEXT_PUBLIC_API_URL: `https://${host}/graphql`,
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      },
      environment: "render",
    });
    assert.match(
      messages(result.errors),
      /must be a public DNS name/,
      `${host} should be refused in production`,
    );
  }
});

test("an INTERNAL host keeps the weaker check, and single labels are fine", () => {
  // Render's own Postgres answers on `dpg-…-a` -- a single label with no dot.
  // Requiring a public DNS name for DATABASE_URL would reject a perfectly
  // good production database and break every deploy.
  const internal = checkEnv({
    app: "api",
    env: {
      ...completeApi,
      APP_ENV: "render",
      DATABASE_URL: "postgresql://u:p@dpg-da02hq7lk1mc73f01hkg-a/medinstru",
      JWT_SECRET: "example-secret-of-suitable-length",
      INQUIRY_IP_HASH_SECRET: "0123456789abcdef0123",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
    },
    environment: "render",
  });
  assert.equal(internal.ok, true, formatReport(internal));

  // Loopback is still wrong there -- that is a developer's .env copied into
  // production, which is the mistake this catches.
  const loopback = checkEnv({
    app: "api",
    env: { ...completeApi, DATABASE_URL: "postgresql://u:p@localhost:5432/medinstru" },
    environment: "render",
  });
  assert.match(messages(loopback.errors), /points at this machine/);
});

test("expectationsFor respects the environment's own empty rules", () => {
  // It filtered on `emptyMeans` alone, so it listed variables as
  // empty-capable on render whose Render rules reject "" -- answering
  // "anywhere" while documenting "here".
  const render = expectationsFor("api", "render").mayBeEmpty.map((r) => r.name);
  assert.ok(!render.includes("INQUIRY_IP_HASH_SECRET"));
  assert.ok(!render.includes("NEXT_PUBLIC_SITE_URL"));

  const local = expectationsFor("api", "localhost").mayBeEmpty.map((r) => r.name);
  assert.ok(local.includes("INQUIRY_IP_HASH_SECRET"));
});

test("a path or query on a base URL is caught too, not just a slash", () => {
  // Only the trailing slash was checked, so `https://laxair.shop/app` and
  // `https://laxair.shop?ref=x` passed -- and both produce a nonsense URL
  // once a path is appended.
  for (const value of [
    "https://laxair.shop/app",
    "https://laxair.shop?ref=x",
    "https://laxair.shop#top",
  ]) {
    const result = checkEnv({
      app: "web",
      env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: value },
      environment: "localhost",
    });
    assert.match(
      messages(result.errors),
      /bare origin|query string or fragment/,
      `${value} should be refused`,
    );
  }
});

test("special-use suffixes are not public names", () => {
  // `api.localhost` is two syntactically valid labels with a non-numeric top
  // label, so every structural rule accepts it -- and RFC 6761 requires
  // resolvers to answer it with loopback. It points a visitor at their own
  // machine exactly as `localhost` does.
  for (const host of [
    "api.localhost",
    "db.local",
    "svc.internal",
    "foo.test",
    "a.example",
    "x.invalid",
  ]) {
    const result = checkEnv({
      app: "web",
      env: {
        ...completeWeb,
        APP_ENV: "render",
        NEXT_PUBLIC_API_URL: `https://${host}/graphql`,
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      },
      environment: "render",
    });
    assert.match(
      messages(result.errors),
      /must be a public DNS name/,
      `${host} should be refused in production`,
    );
  }

  // Near-misses must still pass: the check is on the SUFFIX, not a substring.
  const fine = checkEnv({
    app: "web",
    env: {
      ...completeWeb,
      APP_ENV: "render",
      NEXT_PUBLIC_API_URL: "https://notlocalhost.com/graphql",
      NEXT_PUBLIC_SITE_URL: "https://mylocal.com",
      NEXT_PUBLIC_BLOB_BASE_URL: "https://images.notlocalhost.com",
    },
    environment: "render",
  });
  assert.equal(fine.ok, true, formatReport(fine));
});

test("a URL with no authority is refused", () => {
  // WHATWG accepts `postgresql:foo` as a valid URL with an EMPTY hostname:
  // it parses, it carries the right protocol, and it names no host to
  // connect to. Every host rule reads `hostname`, so without this check they
  // all silently pass on the empty string.
  for (const value of ["postgresql:foo", "postgres:whatever"]) {
    const result = checkEnv({
      app: "api",
      env: { ...completeApi, DATABASE_URL: value },
      environment: "localhost",
    });
    assert.match(messages(result.errors), /names no host/, value);
  }
});

test("an invalid APP_ENV cannot forge log lines", () => {
  // Same class as the blob cross-check: a message that skips displaySafe
  // writes attacker-shaped text straight into the report.
  const result = checkEnv({
    app: "api",
    env: { ...completeApi, APP_ENV: "prod\nFAKE: injected" },
  });
  const shown = formatReport(result);
  assert.match(shown, /not a known environment/);
  assert.doesNotMatch(shown, /\nFAKE: injected/);
});

test("every signal for 'this is a deployment' agrees across modules", () => {
  // web-runtime.js had its own copy of this question, so `APP_ENV=render`
  // switched on the contract's production rules but not its own -- two
  // modules disagreeing, with the strict half missing exactly where someone
  // had said "this is production". Both import ./environment.js now.
  for (const env of [
    { APP_ENV: "render" },
    { RENDER: "true" },
    { RENDER_GIT_COMMIT: "abc123" },
  ]) {
    assert.equal(isDeployedEnvironment(env), true, JSON.stringify(env));
    assert.equal(detectEnvironment(env), "render", JSON.stringify(env));
  }
  assert.equal(isDeployedEnvironment({ APP_ENV: "localhost" }), false);
  assert.equal(isDeployedEnvironment({}), false);
});

test("the matrix does not call a value empty-capable where an environment refuses it", () => {
  // Same bug expectationsFor had: answering "anywhere" while documenting
  // "here". INQUIRY_IP_HASH_SECRET has an emptyMeans AND a Render rule that
  // rejects "".
  const matrix = formatMatrix("api");
  const row = matrix
    .split("\n")
    .find((line) => line.startsWith("INQUIRY_IP_HASH_SECRET"));
  assert.ok(row, "expected a row for INQUIRY_IP_HASH_SECRET");
  assert.match(row, /not everywhere/);
});

test("placeholder terms do not match inside ordinary values", () => {
  // Unanchored `todo` flagged `https://todoapp.example.com`. A false positive
  // refuses a deploy over a perfectly good value, which is how a check earns
  // a reputation for crying wolf.
  const ordinary = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "https://todoapp.example.com" },
    environment: "localhost",
  });
  assert.doesNotMatch(messages(ordinary.warnings), /placeholder/);

  const genuine = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_SITE_URL: "https://change-me.example.com" },
    environment: "localhost",
  });
  assert.match(messages(genuine.warnings), /placeholder/);
});

test("an empty blob base URL is refused in production", () => {
  // Empty is a legal, documented value on a laptop -- images resolve against
  // the app's own origin. In production that same value is a silent
  // regression: every product image served by Render instead of Cloudflare,
  // with nothing failing anywhere. The variable's `emptyMeans` text describes
  // the laptop case, and the production rule is what keeps it there.
  const result = checkEnv({
    app: "web",
    env: { ...completeWeb, APP_ENV: "render", NEXT_PUBLIC_BLOB_BASE_URL: "" },
    environment: "render",
  });
  assert.equal(result.ok, false);
  assert.match(messages(result.errors), /NEXT_PUBLIC_BLOB_BASE_URL/);
  assert.match(messages(result.errors), /instead of the CDN/);

  // ...and still legal on a laptop, which is the whole point of the split.
  const local = checkEnv({
    app: "web",
    env: { ...completeWeb, NEXT_PUBLIC_BLOB_BASE_URL: "" },
    environment: "localhost",
  });
  assert.equal(local.ok, true, formatReport(local));
});

test("free-form WhatsApp with no template is legal, but not in production", () => {
  // `whatsapp.service.ts` refuses a send only when the template AND free-form
  // are both absent, so free-form with no template is a configuration the
  // service supports. An earlier version of this contract called it an error
  // outright, which forbade the one thing the option exists to enable.
  const localFreeForm = checkEnv({
    app: "api",
    env: {
      ...completeApi,
      WHATSAPP_ACCESS_TOKEN: "a-token",
      WHATSAPP_PHONE_NUMBER_ID: "123456789",
      WHATSAPP_TEMPLATE_NAME: "",
      WHATSAPP_ALLOW_FREE_FORM: "true",
    },
    environment: "localhost",
  });
  assert.equal(localFreeForm.ok, true, formatReport(localFreeForm));

  // On Render the 24h window is never open -- the marketplace always speaks
  // first -- so the same configuration cannot deliver anything.
  const onRender = checkEnv({
    app: "api",
    env: {
      ...completeApiRender,
      WHATSAPP_ALLOW_FREE_FORM: "true",
    },
    environment: "render",
  });
  assert.equal(onRender.ok, false);
  assert.match(messages(onRender.errors), /WHATSAPP_ALLOW_FREE_FORM/);
  assert.match(messages(onRender.errors), /business-initiated/);

  // The token-without-template check must still fire when free-form is OFF.
  const noWayToSend = checkEnv({
    app: "api",
    env: {
      ...completeApi,
      WHATSAPP_ACCESS_TOKEN: "a-token",
      WHATSAPP_PHONE_NUMBER_ID: "123456789",
      WHATSAPP_TEMPLATE_NAME: "",
      WHATSAPP_ALLOW_FREE_FORM: "false",
    },
    environment: "localhost",
  });
  assert.equal(noWayToSend.ok, false);
  assert.match(messages(noWayToSend.errors), /WHATSAPP_TEMPLATE_NAME is not/);
});

test("a port must be a decimal digit string, not merely coercible", () => {
  // `Number()` accepts all of these and lands in range; Node's `listen()`,
  // Docker's port mapping and Render's dashboard do not agree with it or
  // with each other about what they mean.
  for (const bad of ["1e3", "0x10", " 80 ", "080", "80.0", "+80", ""]) {
    const result = checkEnv({
      app: "api",
      env: { ...completeApi, PORT: bad },
      environment: "localhost",
    });
    assert.equal(result.ok, false, `PORT=${JSON.stringify(bad)} should fail`);
  }

  for (const good of ["1", "4000", "65535"]) {
    const result = checkEnv({
      app: "api",
      env: { ...completeApi, PORT: good },
      environment: "localhost",
    });
    assert.equal(result.ok, true, formatReport(result));
  }

  // Off the top of the range, where a bare `Number.isInteger` check passes.
  const tooHigh = checkEnv({
    app: "api",
    env: { ...completeApi, PORT: "65536" },
    environment: "localhost",
  });
  assert.equal(tooHigh.ok, false);
});

test("an opaque URL cannot hide credentials from the banner", () => {
  // `mailto:u:pw@h.com` PARSES, and an opaque URL has no authority -- so
  // `username`/`password` are empty however much userinfo the text carries,
  // and the whole of it sits in `pathname`. The earlier version asked only
  // those two fields and printed the value verbatim.
  for (const value of [
    "mailto:user:hunter2@example.com",
    "custom:user:hunter2@example.com",
    "urn:x:user:hunter2@example.com",
  ]) {
    const shown = redactUrlCredentials(value);
    assert.ok(!shown.includes("hunter2"), `${value} leaked through`);
    assert.match(shown, /redacted/);
  }

  // The hierarchical path still redacts in place rather than withholding,
  // because there the credential's boundaries are known exactly.
  assert.equal(
    redactUrlCredentials("https://u:hunter2@h.com/x"),
    "https://***@h.com/x",
  );

  // ...and an ordinary value is untouched, including an opaque URL with no
  // `@` at all. Withholding everything would be safe and useless.
  assert.equal(redactUrlCredentials("https://laxair.shop"), "https://laxair.shop");
  assert.equal(redactUrlCredentials("mailto:plain"), "mailto:plain");
});

test("private pseudo-TLDs are refused in production", () => {
  // Not RFC-reserved, but never delegated and routinely typed into a
  // corporate config. `.corp`, `.home` and `.mail` are the three ICANN
  // permanently withheld after measuring name-collision risk.
  for (const host of [
    "api.lan",
    "db.corp",
    "x.home",
    "svc.mail",
    "web.intranet",
    "h.localdomain",
  ]) {
    const result = checkEnv({
      app: "web",
      env: {
        ...completeWeb,
        APP_ENV: "render",
        NEXT_PUBLIC_API_URL: `https://${host}/graphql`,
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        NEXT_PUBLIC_BLOB_BASE_URL: "https://images.laxair.shop",
      },
      environment: "render",
    });
    assert.match(
      messages(result.errors),
      /must be a public DNS name/,
      `${host} should be refused in production`,
    );
  }

  // The suffix rule must not swallow a real host that merely contains one.
  const fine = checkEnv({
    app: "web",
    env: {
      ...completeWeb,
      APP_ENV: "render",
      NEXT_PUBLIC_API_URL: "https://mailchimp.com/graphql",
      NEXT_PUBLIC_SITE_URL: "https://corporate.laxair.shop",
      NEXT_PUBLIC_BLOB_BASE_URL: "https://images.laxair.shop",
    },
    environment: "render",
  });
  assert.equal(fine.ok, true, formatReport(fine));
});
