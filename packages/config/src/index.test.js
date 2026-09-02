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

// API_URL/SITE_URL live in ./web-runtime.js, not the main entry -- they throw
// on a deployment when unset, and the main entry must stay safe to import
// from Node scripts and from apps/api, which do not read them.
//
// They are resolved from process.env at *import* time, so
// asserting them against the statically-imported module would make these
// tests pass or fail based on whatever the developer happens to have
// exported in their shell -- a legitimate NEXT_PUBLIC_API_URL (pointing a
// local build at staging, say) would fail the suite despite the config
// behaving correctly. Re-importing with a unique query string bypasses the
// ESM module cache, so each case gets a genuinely fresh evaluation under an
// environment this test controls.
async function importWithEnv(overrides) {
  // Everything the module reads, PLUS whatever this case overrides.
  //
  // A fixed list missed NODE_ENV, which one case sets and nothing restored --
  // so it leaked into every test that ran afterwards. Deriving the second
  // half from `overrides` means a new case cannot introduce that again.
  const managed = new Set([
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_SITE_URL",
    // BOTH Render markers: resolvePublicUrl treats either as a deployment, so
    // leaving one set meant a developer shell with it exported changed the
    // outcome of the cases covering non-Render behaviour.
    "RENDER",
    "RENDER_GIT_COMMIT",
    ...Object.keys(overrides),
  ]);
  const saved = Object.fromEntries(
    [...managed].map((key) => [key, process.env[key]]),
  );
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

  test("throws instead of falling back to localhost when running on Render", async () => {
    // The whole point. Silently defaulting here publishes localhost canonical
    // URLs, hreflang alternates and OpenGraph images to real crawlers while
    // every page still returns 200.
    await assert.rejects(
      () => importWithEnv({ RENDER: "true" }),
      /NEXT_PUBLIC_API_URL is not set, and this process is running on Render/,
    );
  });

  test("rejects a localhost value on a deployment, not just a missing one", async () => {
    // This is the case that actually occurs. apps/web/Dockerfile declares
    // `ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`, so a build that
    // loses the value produces a POPULATED, plausible, wrong variable rather
    // than an empty one -- an absence check alone would never fire.
    await assert.rejects(
      () =>
        importWithEnv({
          RENDER: "true",
          NEXT_PUBLIC_API_URL: "https://localhost:4000/graphql",
          NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        }),
      /must be a public DNS name/,
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

  test("the localhost defaults still apply everywhere that is not Render", async () => {
    // Three green checks depend on this: `test-web` builds with no env at
    // all, `docker-web-prod-boot` boots the real prod image with none, and a
    // bare `pnpm dev` has none either. NODE_ENV=production must NOT trigger
    // the strict path -- the prod image sets it wherever it is built.
    const cfg = await importWithEnv({ NODE_ENV: "production" });
    assert.equal(cfg.API_URL, "http://localhost:4000/graphql");
    assert.equal(cfg.SITE_URL, "http://localhost:3000");
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

test("a malformed URL's value is never echoed", async () => {
  // A malformed URL is the shape most likely to carry a pasted credential:
  // `https://user:secret@` fails to parse, so it takes the throw path --
  // which used to include the raw value, landing the secret in a deploy log.
  await assert.rejects(
    () =>
      importWithEnv({
        // The validation only runs on a deployment -- off Render a localhost
        // value is correct and nothing is checked.
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "https://user:secret@",
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      }),
    (error) => {
      assert.match(error.message, /NEXT_PUBLIC_API_URL is not a valid URL/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("a non-HTTP scheme is refused on a deployment", async () => {
  // `file:///x` and `javascript:...` have hostnames no loopback list would
  // flag, and neither is something a visitor's browser can fetch from.
  for (const value of ["file:///etc/passwd", "javascript:alert(1)"]) {
    await assert.rejects(
      () =>
        importWithEnv({
          RENDER: "true",
          NEXT_PUBLIC_API_URL: value,
          NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        }),
      /must be an https:\/\/ URL/,
    );
  }

  // A pasted SECRET is a valid URL whose protocol is the first half of it,
  // so echoing the scheme echoes the secret. Nothing derived from the value
  // is safe to show once the value might not be a URL at all.
  await assert.rejects(
    () =>
      importWithEnv({
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "hunter2:the-rest-of-the-secret",
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      }),
    (error) => {
      assert.doesNotMatch(error.message, /hunter2/);
      assert.match(error.message, /Value not shown/);
      return true;
    },
  );
});

test("embedded credentials are refused, and never echoed", async () => {
  // NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
  // a credential here would ship to every visitor -- far more public than any
  // log. The message must not repeat it either.
  await assert.rejects(
    () =>
      importWithEnv({
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "https://user:hunter2@api.example.com/graphql",
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      }),
    (error) => {
      assert.match(error.message, /embeds credentials/);
      assert.doesNotMatch(error.message, /hunter2/);
      return true;
    },
  );
});

test("the BUILD-time marker rejects just as the runtime one does", async () => {
  // Every other case uses RENDER=true, which is the RUNTIME signal. A Docker
  // build on Render sees only RENDER_GIT_COMMIT -- and that is the half that
  // matters most, because NEXT_PUBLIC_* are inlined into the client bundle
  // then and cannot be corrected afterwards.
  await assert.rejects(
    () =>
      importWithEnv({
        RENDER_GIT_COMMIT: "abc123",
        NEXT_PUBLIC_API_URL: "https://localhost:4000/graphql",
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      }),
    /must be a public DNS name/,
  );
});

test("SITE_URL is validated too, not just API_URL", async () => {
  // Every rejection case so far fails while initialising API_URL, so none
  // proved SITE_URL is checked at all. Give API_URL a valid value and the
  // failure has to come from the other one.
  await assert.rejects(
    () =>
      importWithEnv({
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
        NEXT_PUBLIC_SITE_URL: "https://localhost:3000",
      }),
    /NEXT_PUBLIC_SITE_URL must be a public DNS name/,
  );

  await assert.rejects(
    () =>
      importWithEnv({
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
      }),
    /NEXT_PUBLIC_SITE_URL is not set/,
  );
});

test("production requires a public DNS name, which rejects every IP literal", async () => {
  // Five review rounds went into enumerating IANA special-purpose ranges --
  // fec0::/10, 100::/64, 2001:2::/48, 3fff::/20, ORCHIDv2 -- each real, and
  // the list unbounded because IANA is still assigning blocks.
  //
  // None of it was needed. In production this value is always a DNS name: an
  // IP literal cannot get a certificate from the CDN in front of it, and the
  // scheme check already requires https. One rule rejects every literal in
  // both families, plus single-label internal names, and cannot be defeated
  // by a range that does not exist yet.
  // SEQUENTIAL, not Promise.all. importWithEnv mutates the shared
  // process.env and restores it in a finally, so concurrent calls interleave
  // and each one sees another's variables -- the assertions would pass or
  // fail for reasons unrelated to the value under test.
  for (const value of [
    "https://127.0.0.2/graphql",
    "https://192.0.0.1/graphql",
    "https://10.0.0.5/graphql",
    "https://[fec0::1]/graphql",
    "https://[2606:4700::1111]/graphql",
    "https://localhost/graphql",
    "https://api/graphql",
    // Malformed names a bare `includes(".")` check accepted.
    "https://example..com/graphql",
    "https://-.com/graphql",
    "https://ex-.com/graphql",
  ]) {
    await assert.rejects(
      () =>
        importWithEnv({
          RENDER: "true",
          NEXT_PUBLIC_API_URL: value,
          NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
        }),
      /must be a public DNS name/,
      `${value} should be refused`,
    );
  }
});

test("plain http is refused on a deployment", async () => {
  // HSTS is served with a two-year max-age, so a plain-http origin is
  // unreachable for every returning visitor.
  await assert.rejects(
    () =>
      importWithEnv({
        RENDER: "true",
        NEXT_PUBLIC_API_URL: "http://api.laxair.shop/graphql",
        NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
      }),
    /must be an https:\/\/ URL/,
  );
});

test("an internationalized domain is accepted", async () => {
  // WHATWG URL parsing converts these to punycode before the guard sees
  // them, so `例え.テスト` arrives as `xn--r8jz45g.xn--zckzah` -- which a
  // letters-only top-label rule rejects for containing digits and hyphens.
  const cfg = await importWithEnv({
    RENDER: "true",
    NEXT_PUBLIC_API_URL: "https://例え.テスト/graphql",
    NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
  });
  assert.match(cfg.API_URL, /xn--/);
});

test("a real production hostname is accepted", async () => {
  // The other direction: a rule that is too strict breaks a deploy just as
  // surely as one that is too loose.
  const cfg = await importWithEnv({
    RENDER: "true",
    NEXT_PUBLIC_API_URL: "https://api.laxair.shop/graphql",
    NEXT_PUBLIC_SITE_URL: "https://laxair.shop",
  });
  assert.equal(cfg.API_URL, "https://api.laxair.shop/graphql");
});
