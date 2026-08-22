// The single place for configuration in this repo.
//
// Before this package existed, config was scattered by consumer: the web
// app's values lived in apps/web/src/lib/config.ts, while every
// AI-automation setting (model name, reasoning effort, size limits) was
// hardcoded separately inside four different scripts -- three of which
// carried the *same* literal "gpt-5.6" and the same 60,000-character
// limit. Answering "what model are we on?" or bumping every reviewer at
// once meant grepping and editing four files and hoping none were missed.
//
// Plain JavaScript with a hand-written index.d.ts alongside it, rather
// than TypeScript, for one concrete reason: this module has two very
// different consumers. apps/web imports it through TypeScript (and needs
// real literal types -- `LOCALES` feeds a `(typeof LOCALES)[number]`
// union that next-intl's routing depends on), while scripts/*.mjs import
// it as plain Node ESM with no build step at all. Shipping runtime JS +
// declarations satisfies both without asking either one to compile the
// other's format.
//
// Keep this module dependency-free and side-effect-free. apps/web's
// next.config.ts imports it transitively, and Next.js transpiles and
// evaluates next.config.ts at container **boot**, not just at build time
// -- a real ~40-minute production outage came from exactly that path (see
// CLAUDE.md's "Known gotchas"). Anything imported here is on the critical
// path of the app starting at all.
//
// ---------------------------------------------------------------------
// API KEY VALUES DO NOT BELONG IN THIS FILE, ever.
// ---------------------------------------------------------------------
// What lives here is the NAME of the environment variable each AI role
// reads its key from -- never a key value. This file is committed, so a
// value written here enters git history permanently and is readable by
// anyone with repo access and by every CI job. Naming the variable in one
// place gets the real benefit ("where do I look to see what credentials
// this repo needs?") without turning config into a secret store.
//
// Where the values actually live, and the only places they should:
//   - CI:    GitHub repo secrets, injected per-job as `env:` in ci.yml.
//   - Local: your own shell environment. .husky/pre-push reads
//            OPENAI_API_KEY this way and skips with a warning if unset.
// Rotating a key is a secrets change plus a shell change -- no commit.

// ---------------------------------------------------------------------
// Web app
// ---------------------------------------------------------------------

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql";

// Used as `metadataBase` and for absolute OpenGraph image URLs. Next
// requires this once any route uses a relative OG image path.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// English + Hindi for MVP (TECHNICAL_PLAN.md §14) -- additional regional
// languages land in Phase 3, prioritized by where signups concentrate.
// Raw values live here, not in apps/web/src/i18n/routing.ts, so anything
// needing "the app's configured locales" (next.config.ts's Cache-Control
// route matcher, in addition to next-intl's own routing setup) can read
// them without pulling in next-intl's defineRouting() wiring just for a
// list of strings.
export const LOCALES = /** @type {const} */ (["en", "hi"]);
export const DEFAULT_LOCALE = "en";

// ---------------------------------------------------------------------
// Build identity
// ---------------------------------------------------------------------

// Baked in at build time and surfaced as <meta> tags on every page, so the
// exact build a running service is serving can be read with a plain curl.
//
// This exists because of a real incident (2026-08-19): four PRs merged in
// quick succession, Render deployed each service independently, and the web
// app went live with a product-details route calling a `product(id)` query
// the API had not deployed yet. Every detail page returned 500. Nothing
// exposed by either service made that skew visible -- the failure had to be
// noticed by a human hitting the page.
//
// Deliberately BOTH a commit and a timestamp. The SHA identifies a build
// exactly but cannot answer "is this older or newer?" without consulting
// git history, which is not available to someone running curl against a
// deployed URL. The timestamp makes the answer self-contained.
//
// The fallback is the literal string "unknown", never a plausible-looking
// placeholder. next.config.ts's `deploymentId` takes the same value and
// currently compiles to undefined in production -- the feature is declared
// but silently inert, and nothing surfaces that. A visible "unknown" turns
// the same class of misconfiguration into something a curl reveals
// immediately instead of something that hides.
export const BUILD_COMMIT = process.env.NEXT_PUBLIC_BUILD_COMMIT || "unknown";
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "unknown";

// ---------------------------------------------------------------------
// Performance budgets
// ---------------------------------------------------------------------

// These were previously duplicated across two files that measure the same
// thing by different means -- apps/web/test/bundle-budget.spec.ts
// (curl-measured real wire bytes) and apps/web/scripts/perf-budget.mjs
// (Lighthouse's resource-summary). CLAUDE.md's "Known gotchas" calls out
// by name that the two "must move together," which is exactly the sort of
// invariant a human has to remember and eventually won't. One constant,
// imported by both, makes that structural instead of remembered.
//
// The number has a real, documented raise history -- see
// bundle-budget.spec.ts's own comment, which remains the place to record
// *why* each raise happened. Don't raise this reflexively to make a
// failing check pass: this repo's practice is to isolate the exact cause
// first (a side-by-side git worktree diff against main) and record the
// measured bytes.
//
// Worth knowing when comparing the two: Lighthouse reads ~3-4KB higher
// than curl for an identical build (HTTP response header bytes the
// DevTools Protocol counts and curl's body-only measurement doesn't), so
// perf-budget.mjs's margin against this shared number is always a few KB
// thinner than bundle-budget.spec.ts's. That's expected, not a discrepancy
// to "fix" by giving the two different numbers again.
//   191KB -> 194KB: #94 (product-details page) added a real, isolated
//     +2.3KB, curl-measured via a side-by-side git worktree diff against
//     main (186.0KB -> 188.3KB) -- the cost of ProductCard's new <Link> to
//     /products/[id] plus the extra route Next's client router accounts
//     for. 188.3KB alone still fits under 191KB; what actually failed was
//     perf-budget.mjs's *Lighthouse*-measured 192.3KB, which is the same
//     ~3-4KB measurement gap described above eating the remaining margin.
// Raised 194 -> 196 (2026-08-21). The image-optimizer bypass adds ~220
// bytes, MEASURED by building both branches and summing brotli-encoded
// chunk sizes: 756,193 -> 756,413. Main was already sitting at the line,
// so a 220-byte change tipped it.
//
// Worth the trade, and the trade is the point of measuring: those bytes
// remove an origin round trip per product image -- ~1.86s each, proxied
// through Render in Oregon while the R2 edge cache went unused. Trading
// 220 bytes of JS for that is not close.
//
// Raised by 2KB, not to exactly fit: landing a budget one byte above
// current usage means the next honest change fails for no reason, and a
// gate that fails constantly stops being read.
export const JS_BUDGET_BYTES = 196 * 1024;

// §12A targets from TECHNICAL_PLAN.md.
export const LCP_BUDGET_MS = 2500;
export const PERFORMANCE_SCORE_BUDGET = 0.9;

// Lighthouse's SEO category is largely static checks -- canonical present
// and valid, indexable, crawlable links, descriptive link text, meta
// description -- so unlike the performance score it should be near-
// deterministic. Starts measured-but-not-enforced anyway: LCP was assumed
// stable too, and 7 of 10 runs failed before that assumption was tested.
export const SEO_SCORE_BUDGET = 1.0;

// Single Lighthouse runs swing wildly on shared CI runners -- confirmed
// repeatedly, most recently 2026-08-19 when unmodified `main` produced
// LCP values from 1.4s to 3.3s within one batch of five. Taking the median
// of several runs (what Lighthouse CI itself does by default) filters a
// single contended run without hiding a consistent regression.
export const LIGHTHOUSE_RUNS = 5;

// ---------------------------------------------------------------------
// HTTP caching
//
// One policy, two origins. apps/api serves cacheable GraphQL GETs and
// apps/web serves the locale page shell, and both want the same answer:
// the browser always revalidates, a shared cache may serve for a while
// without asking, and a stale copy beats a spinner while a fresh one is
// fetched behind it.
//
// These lived in two places until 2026-08-21 -- named constants in
// apps/api/src/graphql-cache.ts and a hand-written literal string in
// apps/web/next.config.ts -- kept in step only by a comment saying the
// web value "matches the API's own". That is the same failure mode this
// package was created for after the JS budget was declared twice: an
// invariant a human has to remember, and eventually will not.

/**
 * How long a SHARED cache (a CDN) may serve a response without asking.
 *
 * 60s is deliberately conservative. The catalogue changes rarely, so a
 * longer window is defensible on hit rate alone -- but there is no
 * invalidation path yet (nothing purges when a seller edits a listing),
 * so this doubles as the worst-case staleness they would see. Raise it
 * once a purge hook exists, not before.
 */
export const SHARED_MAX_AGE_SECONDS = 60;

/**
 * How long a stale response may still be served while a fresh one is
 * fetched in the background.
 *
 * Longer than the fresh window on purpose: past that point the data is
 * stale but still far better than a spinner, and the refresh happens off
 * the critical path.
 */
export const STALE_WHILE_REVALIDATE_SECONDS = 300;

/**
 * The Cache-Control value for a publicly cacheable response.
 *
 * THREE DIRECTIVES, THREE AUDIENCES -- confusing them is the usual way
 * this goes wrong, so they are spelled out:
 *
 *   max-age=0                 the BROWSER's private cache. Zero, so a
 *                             reload always revalidates and nobody is
 *                             stuck on a stale catalogue they cannot
 *                             refresh.
 *   s-maxage=N                SHARED caches only. Overrides max-age for
 *                             them, letting an edge node answer without
 *                             a round trip to the origin.
 *   stale-while-revalidate=M  serve the stale copy IMMEDIATELY and
 *                             refresh behind it. Honoured by browsers as
 *                             well as CDNs.
 *
 * must-revalidate is kept alongside s-maxage because it constrains the
 * BROWSER, which s-maxage deliberately does not touch.
 */
export function publicCacheControl(
  sharedMaxAge = SHARED_MAX_AGE_SECONDS,
  staleWhileRevalidate = STALE_WHILE_REVALIDATE_SECONDS,
) {
  return [
    "public",
    "max-age=0",
    `s-maxage=${sharedMaxAge}`,
    `stale-while-revalidate=${staleWhileRevalidate}`,
    "must-revalidate",
  ].join(", ");
}

/**
 * Browser cache window for the favicon.
 *
 * Its URL never changes, so this cannot be immutable/forever -- but it
 * was previously re-downloaded on every repeat visit, found via a cold
 * vs. warm Lighthouse comparison.
 */
export const FAVICON_MAX_AGE_SECONDS = 86_400;

/**
 * How long a browser may reuse a CORS preflight result.
 *
 * apps/web sends a custom header on every API call (apollo-require-
 * preflight), which makes each one a preflighted cross-origin request.
 * With no max-age the browser re-runs the preflight before EVERY
 * request, paying a full extra round trip each time -- expensive on the
 * high-latency connections this app targets. 86400s is the practical
 * ceiling (Chrome caps at 2h, Firefox at 24h; both clamp rather than
 * reject).
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/**
 * Cache-Control for the service worker script.
 *
 * `no-store`, and NOT `no-cache`, for a reason that cost a live outage on
 * 2026-08-21. A worker enforces the CSP served on its own script,
 * captured at install -- and that CSP is derived from the API URL, so it
 * changes on an API move while sw.js's own bytes do not. `no-cache`
 * permits storing and revalidating, and a 304 revalidation preserves the
 * STORED headers: Cloudflare kept serving a CSP naming a retired host
 * long after the origin stopped sending it, and every worker installed
 * from that copy blocked every API call. `no-store` forbids keeping a
 * copy at all, so headers can never outlive the build that produced them.
 */
export const SERVICE_WORKER_CACHE_CONTROL = "no-store, must-revalidate";

/**
 * HSTS lifetime, in seconds (two years).
 *
 * Deliberately WITHOUT `preload`: submitting to the browser preload list
 * is effectively irreversible (it is baked into browser binaries), so it
 * stays deferred until this header has run in production for a while
 * rather than being added reflexively alongside the rest.
 */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** The assembled HSTS value. Production only -- see hstsHeaderEntries. */
export const HSTS_HEADER_VALUE = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;

/**
 * Clickjacking fallback for browsers that do not honour the CSP
 * frame-ancestors directive. No legitimate embedding use case exists for
 * this marketplace, so the two agree on refusing outright.
 */
export const FRAME_OPTIONS = "DENY";

/** Isolates this origin's browsing context group from any opener. */
export const CROSS_ORIGIN_OPENER_POLICY = "same-origin";

// Tells browsers to trust the declared Content-Type and never sniff a
// different one from the bytes. Without it a response the app intends as
// data can be re-interpreted as script or HTML, which is the whole point
// of the CSP this sits beside.
export const CONTENT_TYPE_OPTIONS = "nosniff";

// Matches what modern browsers already default to, declared explicitly so
// the behaviour is a decision rather than an inherited default that a
// future browser release could change underneath us. Full URL to same
// origin, origin only when the scheme stays as secure, nothing on a
// downgrade.
export const REFERRER_POLICY = "strict-origin-when-cross-origin";

// Every powerful feature is disabled because the app uses none of them --
// verified by grepping apps/web/src for geolocation, camera, microphone,
// getUserMedia, payment and navigator.usb, all zero hits. An empty
// allowlist "()" denies the feature to this document and every iframe,
// so a future dependency cannot quietly start using one.
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * Opts cross-origin responses into exposing real timing and transfer-size
 * data to the Resource Timing API.
 *
 * Browsers zero those values out for privacy without it, which makes a
 * genuine cache hit impossible to confirm from frontend code (RUM) rather
 * than a manual curl.
 */
export const TIMING_ALLOW_ORIGIN = "*";

// ---------------------------------------------------------------------
// Cross-app wire contracts
//
// Everything below was previously declared independently in apps/api and
// apps/web. None of it is validated at runtime by anything, so a drifted
// value fails SILENTLY -- correlation stops joining up, or an image stops
// being recognised as ours. That is the same class of invariant the JS
// budget was in before this package existed.

/**
 * Correlation header names, shared by producer and consumer.
 *
 * apps/web generates and sends the first three; apps/api reads them and
 * echoes requestId back. The API's CORS allowedHeaders list is built from
 * these too, so renaming one in a single app breaks the request outright
 * rather than merely losing a log field.
 */
export const CORRELATION_HEADERS = {
  requestId: "x-request-id",
  sessionId: "x-session-id",
  pageViewId: "x-page-view-id",
  clientRequestId: "x-client-request-id",
};

/**
 * Bounds on a client-supplied correlation id.
 *
 * apps/web produces these ids and apps/api decides whether to accept
 * them; before this, the producer and the validator of the same string
 * had no shared definition. A tightened pattern on one side alone means
 * ids are silently dropped rather than rejected loudly.
 */
export const CORRELATION_ID_MAX_LENGTH = 64;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Path prefix for product images this project manages.
 *
 * apps/api decides which stored images to rewrite to the blob host;
 * apps/web decides which ones it ships a PNG twin for (OpenGraph). Both
 * answer "is this ours?" and must agree, or the API rewrites a URL the
 * web app then declines to treat as managed.
 */
export const MANAGED_IMAGE_PREFIX = "/products/";

// ---------------------------------------------------------------------
// Auth and session lifetimes
//
// Security-relevant policy that was expressed as bare string literals
// inside a module constructor and a service call -- not even named
// constants, and impossible to find without knowing where to look.

/** Session JWT lifetime. */
export const SESSION_TOKEN_TTL = "7d";

/**
 * Onboarding JWT lifetime.
 *
 * Deliberately far shorter than a session: it proves only "this phone
 * completed OTP verification" and is spent immediately on
 * completeOnboarding.
 */
export const ONBOARDING_TOKEN_TTL = "15m";

/** How long a requested OTP stays valid. */
// ---------------------------------------------------------------------------
// Product inquiries over WhatsApp (#91)
// ---------------------------------------------------------------------------

// NAMES of the environment variables holding Meta credentials -- never the
// values. This package is committed, so a value here would enter git history
// permanently and be readable by every CI job. Same rule as the AI roles'
// apiKeyEnv above.
export const WHATSAPP_ACCESS_TOKEN_ENV = "WHATSAPP_ACCESS_TOKEN";
export const WHATSAPP_PHONE_NUMBER_ID_ENV = "WHATSAPP_PHONE_NUMBER_ID";

// Pinned rather than "latest". Meta's Graph API is versioned and dated; an
// unpinned call silently changes behaviour when they roll a version, which
// for an outbound-message path means discovering it from failed deliveries.
export const WHATSAPP_API_VERSION = "v21.0";
export const WHATSAPP_API_BASE_URL = "https://graph.facebook.com";

// Bounds on what a buyer can submit. Not cosmetic: message is interpolated
// into an outbound message body, and an unbounded field is both an abuse
// vector and a way to exceed the provider's own payload limits.
export const INQUIRY_NAME_MAX_LENGTH = 80;
export const INQUIRY_MESSAGE_MAX_LENGTH = 1000;

// Anonymous callers can trigger outbound WhatsApp messages to real sellers,
// so this mutation is a spam vector by construction. The API has no
// throttling of any kind today -- not even on OTP -- so the limit lives in
// the inquiry path itself rather than assuming a global one exists.
export const INQUIRY_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const INQUIRY_RATE_LIMIT_PER_PHONE = 5;
export const INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT = 2;

export const OTP_TTL_MS = 5 * 60 * 1000;

/** Idle window after which a browser session id is regenerated. */
export const SESSION_IDLE_MINUTES = 30;

/** Cookie holding the browser session id. */
export const SESSION_COOKIE_NAME = "mi_sid";

// ---------------------------------------------------------------------
// UI

/** Page-number buttons rendered before the pagination control truncates. */
export const MAX_VISIBLE_PAGES = 10;

/** The card size every OpenGraph consumer sizes its large preview against. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

// ---------------------------------------------------------------------
// AI automations
// ---------------------------------------------------------------------

// Cross-vendor independence is a deliberate design property, not an
// accident: whoever implements a change here is Claude (Anthropic), so
// both review passes deliberately run on OpenAI -- no shared training
// data, no shared blind spots, no shared susceptibility to the same
// injected framing. See CLAUDE.md's "AI code review gate". Don't collapse
// these onto one vendor to simplify configuration.
export const OPENAI_REVIEW_MODEL = "gpt-5.6";
export const ANTHROPIC_ANALYSIS_MODEL = "claude-haiku-4-5";

// A circuit breaker against pathological input, NOT a cost or attention
// control -- which is what it was originally, at 60,000 chars, and that
// setting turned out to be the single largest source of false blocks.
//
// Measured across this repo's last eleven PRs: eight sit between 1.8KB and
// 27.6KB, and the three largest are 62.0KB (#97), 76.2KB (#90) and 79.4KB
// (#94). So a 60,000 limit bound on roughly a quarter of PRs, exceeding it
// by only 3%, 27% and 32% -- not runaway diffs, just a ceiling set low.
// The consequence was severe out of proportion to the cause: because
// truncation is an unconditional REQUEST_CHANGES override, #97 and #94
// were both blocked while their reviewers reported zero findings, and both
// needed a `git push --no-verify` to land.
//
// 250,000 chars is over 3x the largest diff this repo has ever produced,
// and ~62k tokens -- unremarkable for gpt-5.6, whose context is far
// larger. The limit still exists for genuinely pathological input (a
// vendored dependency, a repo-wide reformat, a lockfile regeneration),
// where a diff review has close to zero value anyway and the fail-closed
// behaviour remains correct.
//
// Raising this is only safe because truncation now degrades gracefully:
// scripts/lib/diff-ordering.mjs drops generated content first, then
// budgets per file so nothing is silently invisible. The old flat
// `diff.slice(0, LIMIT)` head-slice gave PR #94's reviewer 31 files
// complete and 8 files at zero bytes, with no signal they existed.
export const MAX_INPUT_CHARS = 250_000;

// Default output ceiling. A role may override it (see failureAnalysis) --
// roleConfig() prefers the role's own value when one is declared.
export const MAX_OUTPUT_TOKENS = 8192;

export const AI_ROLES = {
  // ci.yml `ai-code-review` (pass 1) -- diff-only, no CI grounding, the
  // primary code-quality/security gate. Fails closed.
  codeReview: {
    model: OPENAI_REVIEW_MODEL,
    effort: "medium",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  // ci.yml `ai-ci-results-review` (pass 2) -- narrower and more
  // mechanical than pass 1 (did the skip decisions make sense, do the CI
  // results look sane), hence lower effort. Fails closed.
  ciResultsReview: {
    model: OPENAI_REVIEW_MODEL,
    effort: "low",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  // .husky/pre-push local precheck -- same effort as pass 1 on purpose: a
  // local pass weaker than the CI pass it previews can only miss findings
  // CI then raises, and each miss costs a full CI round-trip. Fails OPEN.
  prePushPrecheck: {
    model: OPENAI_REVIEW_MODEL,
    effort: "medium",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  // ci.yml `ai-failure-analysis` -- root-cause guess over a failed job's
  // logs. Anthropic rather than OpenAI, and a smaller/faster model: this
  // is explicitly a first guess to verify, not a gate.
  failureAnalysis: {
    model: ANTHROPIC_ANALYSIS_MODEL,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    // Deliberately far below MAX_OUTPUT_TOKENS: this role produces a short
    // root-cause + suggested-fix comment on a PR, not a full review, and an
    // 8k ceiling would only invite a wall of text nobody reads. Declared
    // here as a real role-specific setting rather than left hardcoded at
    // the call site, so the config stays the single answer to "what limits
    // does this automation run under?"
    maxOutputTokens: 1024,
  },
};

/**
 * Resolves a role's API key from the environment at call time. Returns the
 * value (the SDK needs it) but never logs, caches, or persists it -- and
 * the error text names only the *variable*, never any part of the value,
 * so a misconfiguration can't leak a partially-set key into a public CI log.
 */
export function resolveApiKey(roleName, env = process.env) {
  const role = requireRole(roleName);
  const value = env[role.apiKeyEnv];
  if (!value) {
    throw new Error(
      `${role.apiKeyEnv} is not set (required by the "${roleName}" AI role). ` +
        "In CI it comes from GitHub repo secrets; locally, export it in your shell.",
    );
  }
  return value;
}

/** A role's own settings merged with the shared limits. */
export function roleConfig(roleName) {
  const role = requireRole(roleName);
  return {
    ...role,
    maxInputChars: MAX_INPUT_CHARS,
    // A role's own declared ceiling wins over the shared default.
    maxOutputTokens: role.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  };
}

function requireRole(roleName) {
  const role = AI_ROLES[roleName];
  if (!role) {
    throw new Error(
      `Unknown AI role "${roleName}" — expected one of: ${Object.keys(AI_ROLES).join(", ")}`,
    );
  }
  return role;
}
