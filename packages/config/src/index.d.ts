// Hand-written declarations for index.js -- see that file's own header for
// why this package ships runtime JS plus declarations rather than
// TypeScript (two consumers: apps/web compiles it, scripts/*.mjs import it
// as plain Node ESM with no build step).
//
// The literal types here are load-bearing, not cosmetic: LOCALES must stay
// a readonly tuple of string literals so `(typeof LOCALES)[number]`
// resolves to the "en" | "hi" union that next-intl's routing and
// apps/web's `[locale]` route params depend on. A plain `string[]` here
// would silently widen that union and break locale type-safety across the
// whole web app.

export declare const API_URL: string;
export declare const SITE_URL: string;

export declare const LOCALES: readonly ["en", "hi"];
export declare const DEFAULT_LOCALE: (typeof LOCALES)[number];

export declare const BUILD_COMMIT: string;
export declare const BUILD_TIME: string;

export declare const SHARED_MAX_AGE_SECONDS: number;
export declare const STALE_WHILE_REVALIDATE_SECONDS: number;
export declare function publicCacheControl(
  sharedMaxAge?: number,
  staleWhileRevalidate?: number,
): string;
export declare const FAVICON_MAX_AGE_SECONDS: number;
export declare const CORS_PREFLIGHT_MAX_AGE_SECONDS: number;
export declare const SERVICE_WORKER_CACHE_CONTROL: string;
export declare const HSTS_MAX_AGE_SECONDS: number;
export declare const HSTS_HEADER_VALUE: string;
export declare const FRAME_OPTIONS: string;
export declare const CROSS_ORIGIN_OPENER_POLICY: string;
export declare const CONTENT_TYPE_OPTIONS: string;
export declare const REFERRER_POLICY: string;
export declare const PERMISSIONS_POLICY: string;
export declare const TIMING_ALLOW_ORIGIN: string;
export declare const CORRELATION_HEADERS: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly pageViewId: string;
  readonly clientRequestId: string;
};
export declare const CORRELATION_ID_MAX_LENGTH: number;
export declare const CORRELATION_ID_PATTERN: RegExp;
export declare const MANAGED_IMAGE_PREFIX: string;
// Literal types, not `string`, for the same reason LOCALES is declared
// as a literal tuple: @nestjs/jwt types `expiresIn` as the `ms` package's
// StringValue union, and a widened `string` is not assignable to it. The
// hand-written declarations are what let one shared value satisfy a
// consumer with a narrower type than the value's own runtime shape.
export declare const SESSION_TOKEN_TTL: "7d";
export declare const ONBOARDING_TOKEN_TTL: "15m";
export declare const INQUIRY_NAME_MAX_LENGTH: number;
export declare const INQUIRY_MESSAGE_MAX_LENGTH: number;
export declare const INQUIRY_RATE_LIMIT_WINDOW_MS: number;
export declare const INQUIRY_RATE_LIMIT_PER_PHONE: number;
export declare const INQUIRY_RATE_LIMIT_PER_PHONE_PRODUCT: number;
export declare const INQUIRY_RATE_LIMIT_PER_IP: number;
export declare const INQUIRY_RATE_LIMIT_PER_SELLER: number;
export declare const INQUIRY_TRUST_PROXY_HEADERS_ENV: string;
export declare const INQUIRY_IP_HASH_SECRET_ENV: string;
export declare const OTP_TTL_MS: number;
export declare const SESSION_IDLE_MINUTES: number;
export declare const SESSION_COOKIE_NAME: string;
export declare const MAX_VISIBLE_PAGES: number;
export declare const OG_IMAGE_WIDTH: number;
export declare const OG_IMAGE_HEIGHT: number;
export declare const JS_BUDGET_BYTES: number;
export declare const LCP_BUDGET_MS: number;
export declare const PERFORMANCE_SCORE_BUDGET: number;
export declare const SEO_SCORE_BUDGET: number;
export declare const LIGHTHOUSE_RUNS: number;

export declare const OPENAI_REVIEW_MODEL: string;
export declare const ANTHROPIC_ANALYSIS_MODEL: string;

export declare const MAX_INPUT_CHARS: number;
export declare const MAX_OUTPUT_TOKENS: number;

export type AiRoleName =
  | "codeReview"
  | "ciResultsReview"
  | "prePushPrecheck"
  | "failureAnalysis";

export interface AiRole {
  model: string;
  /** Absent for roles whose SDK has no reasoning-effort concept. */
  effort?: "low" | "medium" | "high";
  /** The NAME of the env var holding the key -- never a key value. */
  apiKeyEnv: string;
  /** Overrides MAX_OUTPUT_TOKENS for this role when present. */
  maxOutputTokens?: number;
}

export declare const AI_ROLES: Record<AiRoleName, AiRole>;

export declare function resolveApiKey(
  roleName: AiRoleName,
  env?: NodeJS.ProcessEnv,
): string;

export declare function roleConfig(
  roleName: AiRoleName,
): AiRole & { maxInputChars: number; maxOutputTokens: number };
