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

describe("web config", () => {
  test("falls back to local defaults when env vars are unset", () => {
    // These are the exact fallbacks apps/web relied on before this package
    // existed -- changing one silently changes local dev for everyone.
    assert.equal(API_URL, "http://localhost:4000/graphql");
    assert.equal(SITE_URL, "http://localhost:3000");
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
});

describe("shared limits", () => {
  test("match the values the scripts previously hardcoded separately", () => {
    assert.equal(MAX_INPUT_CHARS, 60_000);
    assert.equal(MAX_OUTPUT_TOKENS, 8192);
  });
});
