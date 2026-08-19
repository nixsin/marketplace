import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AI_ROLES,
  API_URL,
  DEFAULT_LOCALE,
  LOCALES,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  OPENAI_REVIEW_MODEL,
  ANTHROPIC_ANALYSIS_MODEL,
  SITE_URL,
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
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await import(`./index.js?case=${Math.random()}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("web config", () => {
  test("falls back to local defaults when env vars are unset", async () => {
    // The exact fallbacks apps/web relied on before this package existed --
    // changing one silently changes local dev for everyone.
    const cfg = await importWithEnv({});
    assert.equal(cfg.API_URL, "http://localhost:4000/graphql");
    assert.equal(cfg.SITE_URL, "http://localhost:3000");
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
    assert.equal(MAX_INPUT_CHARS, 60_000);
    assert.equal(MAX_OUTPUT_TOKENS, 8192);
  });
});
