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

export declare const JS_BUDGET_BYTES: number;
export declare const LCP_BUDGET_MS: number;
export declare const PERFORMANCE_SCORE_BUDGET: number;
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

// --- Blob storage -----------------------------------------------------------

export interface BlobProvider {
  /** Whether the provider speaks the S3 API, and so needs no new adapter. */
  s3Compatible: boolean;
  /** Endpoint template; `{account}` and `{region}` are substituted. */
  endpoint: string;
  region: string;
  needs: string[];
}

export declare const BLOB_PROVIDERS: Record<string, BlobProvider>;
export declare const BLOB_PROVIDER: string;
export declare const BLOB_BUCKET: string;
export declare const BLOB_ACCOUNT: string;
export declare const BLOB_REGION: string;
export declare const BLOB_ENDPOINT: string;
export declare const BLOB_PUBLIC_BASE_URL: string;

/** Env var NAMES holding credentials -- never the values themselves. */
export declare const BLOB_CREDENTIAL_ENV: {
  accessKeyId: string;
  secretAccessKey: string;
};

export declare function blobEndpoint(env?: NodeJS.ProcessEnv): string;

/**
 * Public URL for a stored object. Falls back to a root-relative path when
 * no provider is configured, so existing committed images keep working.
 */
export declare function blobUrl(key: string, baseUrl?: string): string;

export declare function resolveBlobCredentials(env?: NodeJS.ProcessEnv): {
  accessKeyId: string;
  secretAccessKey: string;
};
