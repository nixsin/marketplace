import { randomUUID } from "node:crypto";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AI_ROLES,
  ANTHROPIC_ANALYSIS_MODEL,
  CORRELATION_HEADERS,
  CORRELATION_ID_MAX_LENGTH,
  CORRELATION_ID_PATTERN,
  DEFAULT_LOCALE,
  LOCALES,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  OPENAI_REVIEW_MODEL,
  SERVICE_WORKER_CACHE_CONTROL,
  SHARED_MAX_AGE_SECONDS,
  STALE_WHILE_REVALIDATE_SECONDS,
  publicCacheControl,
  resolveApiKey,
  roleConfig,
} from "./index.js";

// API_URL/SITE_URL are resolved from process.env at *import* time, so
// asserting them against the statically-imported module would make these
// tests pass or fail based on whatever the developer happens to have
// exported in their shell -- a legitimate NEXT_PUBLIC_API_URL (pointing a
// local build at staging, say) would fail the suite despite the config
// behaving correctly. Re-importing with a unique query string bypasses the
// ESM module cache, so each case gets a genuinely fresh evaluation under an
// environment this test controls.
async function importWithEnv(overrides) {
  const saved = {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    // RENDER decides whether the localhost defaults are a fallback or a hard
    // error, so a case must be able to set it -- and it must be cleared for
    // every other case, or a developer with it exported would fail the suite.
    RENDER: process.env.RENDER,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await import(`./web-runtime.js?case=${Math.random()}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("web config", () => {
  test("THROWS when unset — there is no fallback, in any environment", async () => {
    // This used to assert a localhost fallback. That fallback was the app's
    // worst configuration failure: a deploy that lost NEXT_PUBLIC_SITE_URL
    // served canonical URLs and OpenGraph images pointing at localhost, to
    // real crawlers, with every page still returning 200.
    //
    // A default cannot tell "not configured yet" from "production lost it".
    // Removing it makes both loud, and only one of them was ever cheap to fix.
    await assert.rejects(
      () => importWithEnv({}),
      /NEXT_PUBLIC_API_URL is not set. There is no default/,
    );
  });

  test("the error says how to fix it, for both local and Render", async () => {
    // A hard failure at boot is only an improvement if it is actionable.
    await assert.rejects(
      () => importWithEnv({}),
      (error) => {
        assert.match(error.message, /copy apps\/web\/.env.example/);
        assert.match(error.message, /pass it as a Docker build arg/);
        return true;
      },
    );
  });

  test("prefers the environment over the fallback when set", async () => {
    // The path that actually runs in CI and production -- untested before,
    // which is how the fallback assertion above looked correct while being
    // environment-dependent.
    const cfg = await importWithEnv({
      NEXT_PUBLIC_API_URL: "https://api.example.test/graphql",
      NEXT_PUBLIC_SITE_URL: "https://example.test",
    });
    assert.equal(cfg.API_URL, "https://api.example.test/graphql");
    assert.equal(cfg.SITE_URL, "https://example.test");
  });

  test("throws instead of falling back to localhost when running on Render", async () => {
    // The whole point. Silently defaulting here publishes localhost canonical
    // URLs, hreflang alternates and OpenGraph images to real crawlers while
    // every page still returns 200.
    await assert.rejects(
      () => importWithEnv({ RENDER: "true" }),
      /NEXT_PUBLIC_API_URL is not set. There is no default/,
    );
  });

  test("rejects a localhost value on Render, not just a missing one", async () => {
    // This is the case that actually occurs. apps/web/Dockerfile declares
    // `ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`, so a build that
    // loses the value produces a POPULATED, plausible, wrong variable rather
    // than an empty one -- an absence check alone would never fire.
    await assert.rejects(
      () =>
        importWithEnv({
          RENDER: "true",
          NEXT_PUBLIC_API_URL: "http://localhost:4000/graphql",
          NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        }),
      /points at localhost while running on Render/,
    );
  });

  test("accepts real values on Render", async () => {
    const cfg = await importWithEnv({
      RENDER: "true",
      NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
      NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
    });
    assert.equal(cfg.API_URL, "https://api.laxair.shop/graphql");
    assert.equal(cfg.SITE_URL, "https://laxair.shop");
  });

  test("localhost values are accepted off Render, and only there", async () => {
    // Localhost is the CORRECT value on a laptop and in CI -- it is only
    // catastrophic in production, which is why the hostname check is keyed on
    // Render rather than applied everywhere.
    const cfg = await importWithEnv({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "http://localhost:4000/graphql",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
    assert.equal(cfg.API_URL, "http://localhost:4000/graphql");
    assert.equal(cfg.SITE_URL, "http://localhost:3000");
  });

  test("a malformed URL is rejected before anything uses it", async () => {
    await assert.rejects(
      () =>
        importWithEnv({
          NEXT_PUBLIC_API_URL: "api.laxair.shop/graphql",
          NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        }),
      /NEXT_PUBLIC_API_URL is not a valid URL/,
    );
  });

  test("locales are en + hi with en as the default", () => {
    assert.deepEqual([...LOCALES], ["en", "hi"]);
    assert.ok(LOCALES.includes(DEFAULT_LOCALE));
  });
});

describe("AI_ROLES", () => {
  test("declares every role the repo's automations actually use", () => {
    assert.deepEqual(Object.keys(AI_ROLES).sort(), [
      "ciResultsReview",
      "codeReview",
      "failureAnalysis",
      "prePushPrecheck",
    ]);
  });

  test("no role embeds a literal API key value", () => {
    // Guards this package's own central rule: apiKeyEnv is a variable
    // NAME. A real key starts with "sk-"; one committed here would enter
    // git history permanently.
    for (const [name, role] of Object.entries(AI_ROLES)) {
      assert.ok(role.model, `${name} is missing a model`);
      assert.ok(
        /^[A-Z][A-Z0-9_]*$/.test(role.apiKeyEnv),
        `${name}.apiKeyEnv should be an env var NAME, got "${role.apiKeyEnv}"`,
      );
      assert.ok(!/^sk-/.test(role.apiKeyEnv), `${name}.apiKeyEnv looks like a key value`);
      assert.equal(role.apiKey, undefined, `${name} must not carry a key value`);
    }
  });

  test("both review passes run on OpenAI while failure analysis runs on Anthropic", () => {
    // Cross-vendor independence is deliberate -- the implementer is Claude.
    assert.equal(AI_ROLES.codeReview.model, OPENAI_REVIEW_MODEL);
    assert.equal(AI_ROLES.ciResultsReview.model, OPENAI_REVIEW_MODEL);
    assert.equal(AI_ROLES.prePushPrecheck.model, OPENAI_REVIEW_MODEL);
    assert.equal(AI_ROLES.failureAnalysis.model, ANTHROPIC_ANALYSIS_MODEL);
    assert.equal(AI_ROLES.failureAnalysis.apiKeyEnv, "ANTHROPIC_API_KEY");
  });

  test("the local precheck matches CI pass 1's effort, and pass 2 stays lower", () => {
    assert.equal(AI_ROLES.prePushPrecheck.effort, AI_ROLES.codeReview.effort);
    assert.equal(AI_ROLES.ciResultsReview.effort, "low");
  });
});

describe("resolveApiKey", () => {
  test("returns the value from the role's declared env var", () => {
    assert.equal(resolveApiKey("codeReview", { OPENAI_API_KEY: "v" }), "v");
  });

  test("reads ANTHROPIC_API_KEY for the failure-analysis role", () => {
    const key = resolveApiKey("failureAnalysis", {
      ANTHROPIC_API_KEY: "anthropic-value",
      OPENAI_API_KEY: "openai-value",
    });
    assert.equal(key, "anthropic-value");
  });

  test("throws naming the variable when unset or empty", () => {
    assert.throws(() => resolveApiKey("codeReview", {}), /OPENAI_API_KEY is not set/);
    assert.throws(() => resolveApiKey("codeReview", { OPENAI_API_KEY: "" }), /is not set/);
  });

  test("the error message never contains any part of the key value", () => {
    const secret = "sk-super-secret-value";
    try {
      resolveApiKey("failureAnalysis", { OPENAI_API_KEY: secret });
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(!err.message.includes(secret));
      assert.ok(!err.message.includes("super-secret"));
      assert.match(err.message, /ANTHROPIC_API_KEY/);
    }
  });

  test("throws on an unknown role rather than returning undefined", () => {
    assert.throws(() => resolveApiKey("notARole", {}), /Unknown AI role "notARole"/);
  });
});

describe("roleConfig", () => {
  test("merges shared limits into the role's own settings", () => {
    const cfg = roleConfig("codeReview");
    assert.equal(cfg.model, OPENAI_REVIEW_MODEL);
    assert.equal(cfg.effort, "medium");
    assert.equal(cfg.maxInputChars, MAX_INPUT_CHARS);
    assert.equal(cfg.maxOutputTokens, MAX_OUTPUT_TOKENS);
  });

  test("returns a copy, so a caller can't mutate the shared config", () => {
    roleConfig("codeReview").effort = "mutated";
    assert.equal(AI_ROLES.codeReview.effort, "medium");
  });

  test("a role's own maxOutputTokens overrides the shared default", () => {
    // failureAnalysis wants a much smaller ceiling than the reviewers: it
    // produces a short root-cause comment, not a full review.
    assert.equal(roleConfig("failureAnalysis").maxOutputTokens, 1024);
    assert.notEqual(MAX_OUTPUT_TOKENS, 1024);
  });

  test("roles without an override fall back to the shared default", () => {
    for (const name of ["codeReview", "ciResultsReview", "prePushPrecheck"]) {
      assert.equal(roleConfig(name).maxOutputTokens, MAX_OUTPUT_TOKENS);
    }
  });
});

describe("shared limits", () => {
  test("match the values the scripts previously hardcoded separately", () => {
    // Raised 60_000 -> 250_000: the old ceiling bound on ~1 in 4 PRs and
    // blocked two whose reviewers reported zero findings. 250k is >3x the
    // largest diff this repo has produced (79,402 chars on #94).
    assert.equal(MAX_INPUT_CHARS, 250_000);
    assert.ok(MAX_INPUT_CHARS > 79_402, "must exceed the largest diff this repo has produced");
    assert.equal(MAX_OUTPUT_TOKENS, 8192);
  });
});

test("publicCacheControl emits the exact directives, in order", () => {
  // Order and spelling are load-bearing: this string is parsed by
  // browsers and by Cloudflare, and a malformed or dropped directive
  // silently changes caching rather than failing. Both apps send this
  // exact value, so a change here moves the API and the web shell
  // together -- which is the entire point of it living here.
  assert.equal(
    publicCacheControl(),
    "public, max-age=0, s-maxage=60, stale-while-revalidate=300, must-revalidate",
  );
});

test("publicCacheControl accepts overrides for tuning and tests", () => {
  assert.equal(
    publicCacheControl(30, 120),
    "public, max-age=0, s-maxage=30, stale-while-revalidate=120, must-revalidate",
  );
});

test("the stale window outlives the fresh one", () => {
  // If these ever invert, stale-while-revalidate stops doing anything and
  // the failure is invisible -- responses just get slower.
  assert.ok(STALE_WHILE_REVALIDATE_SECONDS > SHARED_MAX_AGE_SECONDS);
});

test("staleness stays bounded while no purge hook exists", () => {
  // s-maxage doubles as the worst-case staleness a seller sees after
  // editing a listing, because nothing invalidates the edge on write.
  assert.ok(SHARED_MAX_AGE_SECONDS <= 300);
});

test("the service worker script is never storable", () => {
  // no-cache would permit store-and-revalidate, and a 304 preserves the
  // STORED headers -- which is how a retired API host stayed in the CSP
  // served on sw.js and bricked every installed worker on 2026-08-21.
  assert.match(SERVICE_WORKER_CACHE_CONTROL, /no-store/);
});

test("correlation headers are one definition, not two", () => {
  // apps/web produces three of these and apps/api reads them; the API's
  // CORS allowedHeaders is built from the same object. Renaming one in a
  // single app previously broke the request outright.
  assert.deepEqual(Object.keys(CORRELATION_HEADERS).sort(), [
    "clientRequestId",
    "pageViewId",
    "requestId",
    "sessionId",
  ]);
});

test("ids the web app generates satisfy the pattern the API enforces", () => {
  // Producer and validator of the same string, previously with no shared
  // definition. crypto.randomUUID() is what apps/web actually emits.
  const id = randomUUID();
  assert.ok(CORRELATION_ID_PATTERN.test(id));
  assert.ok(id.length <= CORRELATION_ID_MAX_LENGTH);
});
