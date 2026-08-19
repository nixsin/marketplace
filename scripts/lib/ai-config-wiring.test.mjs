// Guards against a gap the config package's own unit tests structurally
// cannot see: they exercise resolveApiKey() in isolation and pass happily
// even when *no consumer calls it*. That exact situation shipped once --
// AI_ROLES declared an `apiKeyEnv` per role while all four scripts still
// built their SDK clients as bare `new OpenAI()` / `new Anthropic()`,
// which read their own conventional environment variables. Changing
// apiKeyEnv would then have had no effect whatsoever: decorative
// configuration, which is worse than none, because it actively misleads
// anyone reading the config to find out which credential a tool uses.
//
// Source-level assertions rather than behavioural ones, deliberately:
// actually invoking these scripts would mean real API calls with real
// credentials. What's being protected here is a wiring invariant ("the
// declared key source is the one actually used"), and that is visible in
// the source.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CONSUMERS = [
  { file: "scripts/ai-code-review.mjs", role: "codeReview" },
  { file: "scripts/ai-ci-results-review.mjs", role: "ciResultsReview" },
  { file: "scripts/ai-code-review-precheck.mjs", role: "prePushPrecheck" },
  { file: "scripts/analyze-ci-failure.mjs", role: "failureAnalysis" },
];

function read(file) {
  return readFileSync(path.join(REPO_ROOT, file), "utf8");
}

describe("AI script wiring to @medinstru/config", () => {
  for (const { file, role } of CONSUMERS) {
    test(`${file} resolves its key through the config package`, () => {
      const src = read(file);
      assert.match(
        src,
        /resolveApiKey/,
        `${file} must call resolveApiKey() rather than letting the SDK read its own default env var`,
      );
      assert.match(
        src,
        new RegExp(`resolveApiKey\\(\\s*["']${role}["']\\s*\\)`),
        `${file} should resolve the "${role}" role specifically`,
      );
    });

    test(`${file} does not construct its SDK client with no arguments`, () => {
      const src = read(file);
      // The precise regression: `new OpenAI()` / `new Anthropic()` silently
      // fall back to the SDK's conventional env var, bypassing apiKeyEnv.
      assert.doesNotMatch(
        src,
        /new (OpenAI|Anthropic)\(\s*\)/,
        `${file} constructs its client with no apiKey, which ignores the role's apiKeyEnv`,
      );
    });
  }

  test("no AI script hardcodes an SDK output-token limit", () => {
    // The same bypass shape as the API-key one, and it shipped the same
    // way: analyze-ci-failure.mjs passed a literal `max_tokens: 1024`
    // while the config exposed maxOutputTokens, so changing the config
    // would silently leave that script alone. 1024 was the *right* value
    // there -- it's now declared as a role-specific override rather than
    // hardcoded at the call site.
    for (const { file } of CONSUMERS) {
      const src = read(file);
      const offenders = [...src.matchAll(/max_(output_)?tokens:\s*\d+/g)];
      assert.deepEqual(
        offenders.map((m) => m[0]),
        [],
        `${file} hardcodes an output-token limit; declare it on the role and read it from roleConfig()`,
      );
    }
  });

  test("no AI script hardcodes an API key env var name inline", () => {
    // The names belong in the config package's AI_ROLES, so that "which
    // credential does this use?" has exactly one answer. Reading them via
    // a role's own apiKeyEnv is fine; naming them literally is the drift
    // this guards against.
    for (const { file } of CONSUMERS) {
      const src = read(file);
      const offenders = [...src.matchAll(/process\.env\.(OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/g)];
      assert.equal(
        offenders.length,
        0,
        `${file} reads a hardcoded key env var directly; use the role's apiKeyEnv instead`,
      );
    }
  });
});
