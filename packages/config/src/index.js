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
export const JS_BUDGET_BYTES = 194 * 1024;

// §12A targets from TECHNICAL_PLAN.md.
export const LCP_BUDGET_MS = 2500;
export const PERFORMANCE_SCORE_BUDGET = 0.9;

// Single Lighthouse runs swing wildly on shared CI runners -- confirmed
// repeatedly, most recently 2026-08-19 when unmodified `main` produced
// LCP values from 1.4s to 3.3s within one batch of five. Taking the median
// of several runs (what Lighthouse CI itself does by default) filters a
// single contended run without hiding a consistent regression.
export const LIGHTHOUSE_RUNS = 5;

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
