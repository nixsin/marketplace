/**
 * The environment-variable contract, and the checker that enforces it.
 *
 * WHY THIS EXISTS: almost every variable in this repo has a documented
 * failure mode that is SILENT. `API_URL` and `SITE_URL` fall back to
 * localhost, so a web service deployed without them serves
 * `http://localhost:3000` canonicals and OpenGraph images to real crawlers
 * and fetches products from a host that is not there. `INQUIRY_IP_HASH_SECRET`
 * missing does not error -- the per-IP rate limit simply stops running on an
 * unauthenticated endpoint. `WHATSAPP_TEMPLATE_NAME` missing means every
 * business-initiated message is refused. `BLOB_PROVIDER` left at its default
 * makes production write uploads to a container-local directory no CDN
 * serves. None of these fail loudly, and several are only discoverable by
 * noticing an absence weeks later.
 *
 * So this file turns "the app happens to boot" into "the app was configured
 * correctly for the environment it is actually running in".
 *
 * TWO RULES GOVERN EVERYTHING BELOW.
 *
 * 1. NAMES ONLY, NEVER VALUES -- this file is committed. A rule marked
 *    `secret: true` may never have its value echoed into a message, because
 *    these messages land in Render logs and CI output. That mirrors
 *    `resolveApiKey()`, whose error text names only the variable so a
 *    misconfiguration cannot leak a partial key into a public log.
 *
 * 2. SEVERITY IS PER-ENVIRONMENT, not global. A single "required" list would
 *    be wrong everywhere: CI builds the web app with no environment at all
 *    and must keep passing, the dev stack deliberately uses the literal
 *    placeholder `dev-secret-change-me`, and the e2e suite runs with neither.
 *    Marking those required would break three green checks to enforce a rule
 *    that only means anything in production.
 */

import {
  API_DEFAULT_PORT,
  DEV_API_URL,
  DEV_BLOB_BASE_URL,
  DEV_SITE_URL,
} from "./index.js";

/** @typedef {"render" | "github-ci" | "ci-local" | "test" | "localhost" | "unknown"} DeployEnvironment */
/** @typedef {"required" | "recommended" | "optional"} Severity */

/**
 * Every environment is NAMED. There is no catch-all bucket that quietly
 * absorbs anything unrecognised, because "we did not recognise this, so we
 * assumed the most permissive rules" is the same silent-failure shape this
 * whole module exists to remove.
 *
 * - `render`     production, the only place anything is truly required
 * - `github-ci`  a GitHub Actions runner
 * - `ci-local`   CI=true somewhere that is NOT GitHub -- another provider,
 *                or a developer running `CI=true pnpm ...` on their own
 *                machine to reproduce a CI failure
 * - `test`       a Jest/Vitest process, which supplies its own fixtures
 * - `localhost`  a developer's dev server
 * - `unknown`    nothing recognised. Permissive like localhost, but it says
 *                so out loud every single time -- see UNKNOWN_ENVIRONMENT_HINT
 */
/**
 * Named rather than loose strings, so a config file that has to declare
 * APP_ENV declares a value this module actually recognises -- a typo is now a
 * hard error, and a magic string is how you write one.
 */
export const DEPLOY_ENVIRONMENT = /** @type {const} */ ({
  RENDER: "render",
  GITHUB_CI: "github-ci",
  CI_LOCAL: "ci-local",
  TEST: "test",
  LOCALHOST: "localhost",
  UNKNOWN: "unknown",
});

export const DEPLOY_ENVIRONMENTS = /** @type {const} */ (
  Object.values(DEPLOY_ENVIRONMENT)
);

/** Explicit override. Set this and nothing is inferred at all. */
export const APP_ENV_OVERRIDE = "APP_ENV";

/**
 * Is this a real Render deploy -- build or runtime?
 *
 * TWO SIGNALS, because a Docker deploy on Render splits into two processes
 * that see different environments, and only one of them sees `RENDER`.
 *
 * - `RENDER=true` is injected into the running CONTAINER. It is what a
 *   production boot sees, and it is the backstop for everything read at
 *   runtime.
 * - `RENDER_GIT_COMMIT` is passed into the BUILD, via an explicit `ARG` in
 *   apps/web/Dockerfile. Render does not hand arbitrary service variables to
 *   a Docker build -- each one needs its own ARG -- so `RENDER` itself is
 *   absent while the image is being built. This is the only signal available
 *   at that point, and it is the one that matters for `NEXT_PUBLIC_*`, whose
 *   values are inlined into the client bundle at build time and cannot be
 *   corrected afterwards.
 *
 * Neither is set on a developer's machine, and CRUCIALLY neither is set by
 * CI: `docker build --target prod` in `docker-web-prod-boot` passes no build
 * args and `docker run` passes no environment, on purpose -- that job's whole
 * job is proving the image boots with nothing configured. Verified by reading
 * the workflow, not assumed; keying on `NODE_ENV=production` instead would
 * fail that required check every run.
 *
 * This mirrors the existing guard in apps/web/src/lib/site-url.ts, which has
 * gated on `RENDER_GIT_COMMIT` since it was written.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isRenderDeploy(env = process.env) {
  return env.RENDER === "true" || Boolean(env.RENDER_GIT_COMMIT);
}

/**
 * Is this a real deployment, as opposed to a laptop, a CI runner or a test?
 *
 * THE QUESTION APP CODE SHOULD ASK. `isRenderDeploy()` answers "which
 * platform", which is this package's business, not apps/web's -- app code
 * encoding the hosting provider means every future platform is a grep across
 * both apps rather than one line here.
 *
 * Render is the only deployment target today, so this is currently a rename
 * with one call site. That is the point at which the boundary is free to
 * draw; after the second platform it is a refactor.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isDeployedEnvironment(env = process.env) {
  return isRenderDeploy(env);
}

/**
 * Which environment is this process running in?
 *
 * ORDER IS LOAD-BEARING and every branch earns its place:
 *
 * 0. `APP_ENV` wins outright. Inference is a heuristic over variables other
 *    people set for other reasons; an operator who states the answer should
 *    never be second-guessed by it. This is also the escape hatch for any
 *    host this function has never heard of.
 * 1. Render, because it is the only environment where anything is required
 *    and it must never be shadowed by a weaker match.
 * 2. `test` BEFORE either CI branch: a Jest or Vitest process on a GitHub
 *    runner is both at once, and the suites supply their own fixtures.
 * 3. `github-ci` before `ci-local`, since GitHub Actions sets `CI` too --
 *    checking `CI` first would swallow every GitHub run.
 * 4. `ci-local` is the remaining `CI=true`: another provider, or a developer
 *    running `CI=true pnpm install` on a Mac to reproduce a CI failure. Worth
 *    naming separately from `github-ci` precisely because it is a laptop.
 * 5. `localhost` for a dev machine.
 * 6. `unknown` otherwise -- reached when NODE_ENV says production but no
 *    platform is recognised, i.e. something is running this as a deployment
 *    somewhere this function has never seen. Deliberately NOT silently
 *    folded into `localhost`.
 *
 * NOT keyed on NODE_ENV=production for the strict path. The prod image sets
 * it wherever it is built, including in `docker-web-prod-boot`, which boots
 * the real production image with no configuration on purpose. Treating that
 * as production would fail a required check for doing exactly its job -- it
 * lands in `unknown`, which is permissive and says so.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {DeployEnvironment}
 */
export function detectEnvironment(env = process.env) {
  const override = env[APP_ENV_OVERRIDE];
  if (override && DEPLOY_ENVIRONMENTS.includes(/** @type {any} */ (override))) {
    return /** @type {DeployEnvironment} */ (override);
  }

  if (isRenderDeploy(env)) return "render";
  if (env.NODE_ENV === "test" || env.VITEST || env.JEST_WORKER_ID) return "test";
  if (env.GITHUB_ACTIONS === "true") return "github-ci";
  if (env.CI === "true") return "ci-local";

  // A dev server: NODE_ENV development, or simply absent (a bare `node
  // script.mjs`, `pnpm dev`, `nest start`).
  if (env.NODE_ENV === undefined || env.NODE_ENV === "development") {
    return "localhost";
  }

  return "unknown";
}

/**
 * Said out loud on every `unknown` run. An unrecognised environment is not
 * an error -- the prod-image boot test is a legitimate one -- but it must
 * never pass silently, or "permissive by default" becomes invisible exactly
 * where it is most dangerous.
 */
export const UNKNOWN_ENVIRONMENT_HINT =
  `Environment not recognised (no Render, GitHub Actions, CI or test markers, ` +
  `and NODE_ENV is not development). Treating it as a developer machine, so ` +
  `NOTHING is required. If this is a real deployment, set ${APP_ENV_OVERRIDE} ` +
  `to one of: ${DEPLOY_ENVIRONMENTS.join(", ")}.`;

// ---------------------------------------------------------------------
// Value checks. Each returns null when fine, or a human sentence when not.
// They only ever run on a value that is actually present -- absence is the
// severity table's business, not theirs.
// ---------------------------------------------------------------------

/** @param {string[]} protocols */
const isUrl = (protocols) => (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  return protocols.includes(parsed.protocol)
    ? null
    : `must use ${protocols.join(" or ")} (found ${parsed.protocol})`;
};

/** @param {string[]} allowed */
const isOneOf = (allowed) => (value) =>
  allowed.includes(value)
    ? null
    : `must be exactly one of ${allowed.map((a) => `"${a}"`).join(", ")}`;

const isPort = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535
    ? null
    : "must be an integer between 1 and 65535";
};

/** @param {number} n */
const atLeast = (n) => (value) =>
  value.length >= n ? null : `must be at least ${n} characters`;

const isNotBlank = (value) => (value.length > 0 ? null : "must not be empty");

/**
 * @param {RegExp} pattern
 * @param {string} describe
 */
const matches = (pattern, describe) => (value) =>
  pattern.test(value) ? null : describe;

/** Run several checks, reporting the first problem. */
const all =
  (...checks) =>
  (value) => {
    for (const check of checks) {
      const problem = check(value);
      if (problem) return problem;
    }
    return null;
  };

/**
 * Values that mean "nobody filled this in", matched anywhere in the string
 * rather than anchored: `dev-secret-change-me` is the literal this repo ships
 * in .env.example, and the point is that it must never reach production
 * wearing a longer name.
 */
const PLACEHOLDER_PATTERN =
  /(change[-_]?me|your[-_]?(key|secret|token|value|url)|replace[-_]?me|todo|fixme|xxxx+|<[^>]+>)/i;

/** @param {string} value */
function looksLikePlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(value);
}

/**
 * Mistakes worth catching on EVERY variable, whatever it is for.
 *
 * Each produces a value that is subtly wrong in a way the rule's own check
 * cannot see. A DATABASE_URL with a trailing newline still parses as a URL.
 * A JWT_SECRET wrapped in literal quotes still passes a length check -- and
 * then signs tokens with a secret two characters longer than anyone believes.
 *
 * @param {string} value
 * @returns {string | null}
 */
function universalProblem(value) {
  if (value !== value.trim()) {
    // Overwhelmingly a copy-paste or a here-doc that kept its newline. Shells
    // and dotenv both preserve it, and nothing downstream trims.
    return "has leading or trailing whitespace";
  }

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    // A dashboard field is not a shell. Quoting there stores the quotes.
    return "is wrapped in quotes — a dashboard or CI field stores them as part of the value";
  }

  return null;
}

// ---------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------

/**
 * ONE VARIABLE LIST, SHARED BY EVERY ENVIRONMENT.
 *
 * Every environment declares every variable. What differs between a laptop,
 * CI and production is the VALUE, never which variables exist.
 *
 * This replaced a per-environment severity table, and the reason is worth
 * keeping: that table let a variable be "required on render, optional
 * everywhere else", which sounds careful and means the variable is invisible
 * in the four environments where you would actually notice it missing. You
 * find out on the deploy. Declaring everything everywhere moves that
 * discovery to the laptop, which is the only place it is cheap.
 *
 * ABSENT AND EMPTY ARE NOW DIFFERENT THINGS, and this is the detail that
 * makes the model work. `process.env.FOO` is `undefined` when nobody wrote
 * the variable down and `""` when somebody wrote `FOO=`. So:
 *
 *   undefined  -> ERROR. Nobody declared it; this environment is incomplete.
 *   ""         -> a VALUE, meaning "off" -- but only where `emptyMeans` says
 *                 so. Elsewhere an empty value is an error, because a blank
 *                 JWT_SECRET is not a decision anybody made on purpose.
 *   anything   -> validated by `check`, plus `perEnvironment` where the
 *                 rules for a valid value genuinely differ (a localhost URL
 *                 is correct on a laptop and catastrophic in production).
 *
 * An earlier version treated "" as absent. That was wrong under this model:
 * it threw away the one signal that distinguishes "deliberately off" from
 * "forgotten", which is the distinction the whole design now rests on.
 *
 * @typedef {object} EnvRule
 * @property {string} name
 * @property {boolean} secret        Never echo this value into a message.
 * @property {string} why            What actually breaks, in one line.
 * @property {string | null} emptyMeans  What `FOO=` means, or null if empty is invalid.
 * @property {(value: string) => string | null} check
 * @property {Partial<Record<DeployEnvironment, (value: string) => string | null>>} [perEnvironment]
 */

/** Rejects a URL pointing at the machine serving it. */
const notLoopback = (value) => {
  let hostname;
  try {
    ({ hostname } = new URL(value));
  } catch {
    return null; // `check` already reports a malformed URL
  }
  return ["localhost", "localhost.", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(
    hostname,
  )
    ? "points at this machine — every visitor would resolve it to their own"
    : null;
};

/** Rejects plain http, which HSTS makes unreachable for returning visitors. */
const mustBeHttps = (value) =>
  value.startsWith("http://")
    ? "must use https:// in production — HSTS is served with a two-year max-age"
    : null;

/** Rejects a value nobody actually filled in. */
const notPlaceholder = (value) =>
  looksLikePlaceholder(value) ? "is still a placeholder" : null;

const noTrailingSlash = (value) =>
  value.endsWith("/")
    ? "must not end with a trailing slash — it is concatenated with paths"
    : null;

/** @type {EnvRule[]} */
export const API_ENV_CONTRACT = [
  {
    name: "APP_ENV",
    secret: false,
    why: "States which environment this is instead of leaving it inferred.",
    emptyMeans: null,
    devValue: "localhost",
    check: isOneOf([...DEPLOY_ENVIRONMENTS]),
  },
  {
    name: "DATABASE_URL",
    secret: true, // contains the password
    why: "Nothing works without it; Prisma cannot connect.",
    emptyMeans: null,
    devValue: `postgresql://postgres:postgres@localhost:5432/medinstru?schema=public`,
    check: isUrl(["postgresql:", "postgres:"]),
    perEnvironment: { render: notLoopback },
  },
  {
    name: "JWT_SECRET",
    secret: true,
    why: "Signs session tokens. A guessable one is a full authentication bypass.",
    emptyMeans: null,
    devValue: "dev-secret-change-me",
    check: atLeast(16),
    // .env.example and docker-compose.yml ship `dev-secret-change-me` on
    // purpose, so the realistic production failure is not an absent secret
    // but the development one carried forward.
    perEnvironment: { render: notPlaceholder },
  },
  {
    name: "PORT",
    secret: false,
    why: "The port this service listens on.",
    emptyMeans: null,
    devValue: String(API_DEFAULT_PORT),
    check: isPort,
  },
  {
    name: "REDIS_URL",
    secret: true, // Render's connection string carries credentials
    why: "The shared cache. Absent, every read falls through to Postgres.",
    emptyMeans:
      "no shared cache — the API uses a null cache and reads Postgres directly, " +
      "which is a supported state rather than a degraded one",
    devValue: "",
    check: isUrl(["redis:", "rediss:"]),
  },
  {
    name: "INQUIRY_IP_HASH_SECRET",
    secret: true,
    why: "Keys the HMAC that stores a submitter's address as a hash.",
    emptyMeans:
      "the per-IP rate limit does not run — storing nothing is the honest " +
      "option, because an unkeyed digest over IPv4's 2^32 space is reversible",
    devValue: "",
    check: atLeast(16),
    perEnvironment: {
      // The one environment where "off" is not an acceptable answer: this is
      // an abuse control on an unauthenticated endpoint.
      render: (value) => (value ? notPlaceholder(value) : null),
    },
  },
  {
    name: "INQUIRY_TRUST_PROXY_HEADERS",
    secret: false,
    why: 'Only the exact string "true" enables it; anything else reads as off.',
    emptyMeans: null,
    devValue: "false",
    check: isOneOf(["true", "false"]),
  },
  {
    name: "BLOB_PROVIDER",
    secret: false,
    why: "`local` writes uploads into the container filesystem — no CDN serves them and a redeploy discards them.",
    emptyMeans: null,
    devValue: "local",
    check: isOneOf(["r2", "s3", "b2", "spaces", "minio", "local"]),
    perEnvironment: {
      render: (value) =>
        value === "local"
          ? "must not be `local` in production — uploads would go to a container directory no CDN serves and a redeploy discards"
          : null,
    },
  },
  {
    name: "BLOB_ACCESS_KEY_ID",
    secret: true,
    why: "Required once BLOB_PROVIDER is not `local` — enforced by a cross-check, since it depends on another variable.",
    emptyMeans: "no object-storage credentials, which is correct for BLOB_PROVIDER=local",
    devValue: "",
    check: isNotBlank,
  },
  {
    name: "BLOB_SECRET_ACCESS_KEY",
    secret: true,
    why: "Required once BLOB_PROVIDER is not `local` — enforced by a cross-check, since it depends on another variable.",
    emptyMeans: "no object-storage credentials, which is correct for BLOB_PROVIDER=local",
    devValue: "",
    check: isNotBlank,
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    secret: false,
    // Easy to miss on the API service because the name says NEXT_PUBLIC.
    why: "Outbound inquiries embed a product link built from it; without it the link is omitted and the seller has to search instead of clicking.",
    emptyMeans:
      "outbound WhatsApp inquiries omit the product link and log " +
      "[NOT CONFIGURED] — the buyer's name, number and Ref still get through",
    devValue: DEV_SITE_URL,
    check: all(isUrl(["http:", "https:"]), noTrailingSlash),
    perEnvironment: { render: all(notLoopback, mustBeHttps) },
  },
  {
    name: "WHATSAPP_ACCESS_TOKEN",
    secret: true,
    why: "Absent, inquiries are still recorded but never delivered to the seller.",
    emptyMeans: "WhatsApp delivery is off; inquiries are recorded and not sent",
    devValue: "",
    check: matches(/^\S+$/, "must not contain whitespace"),
  },
  {
    name: "WHATSAPP_PHONE_NUMBER_ID",
    secret: false,
    why: "Meta's numeric sender ID.",
    emptyMeans: "WhatsApp delivery is off",
    // A phone NUMBER pasted here instead of the id is the classic mistake,
    // and it arrives carrying + and spaces.
    devValue: "",
    check: matches(
      /^\d{5,}$/,
      "must be Meta's numeric phone number ID, not a phone number (digits only)",
    ),
  },
  {
    name: "WHATSAPP_TEMPLATE_NAME",
    secret: false,
    why: "Business-initiated WhatsApp messages REQUIRE a pre-approved template; free-form text is rejected outside a 24h window the buyer opens.",
    emptyMeans: "WhatsApp delivery is off",
    devValue: "",
    check: matches(
      /^[a-z0-9_]+$/,
      "must be lowercase letters, digits and underscores only — Meta rejects anything else",
    ),
  },
  {
    name: "WHATSAPP_TEMPLATE_LANGUAGE",
    secret: false,
    why: "The template's approved locale. A mismatch is rejected at send time, not at boot.",
    emptyMeans: "the service falls back to its documented default locale",
    devValue: "",
    check: matches(
      /^[a-z]{2}(_[A-Z]{2})?$/,
      'must be a language code such as "en" or "en_US"',
    ),
  },
  {
    name: "WHATSAPP_ALLOW_FREE_FORM",
    secret: false,
    why: "An opt-in for a known-open service window, never a fallback for a missing template.",
    emptyMeans: null,
    devValue: "false",
    check: isOneOf(["true", "false"]),
  },
];

/**
 * NOTE ON ORDERING, so these rules are not mistaken for the only defence.
 *
 * On a deployment, `@medinstru/config` throws while it is being IMPORTED if
 * NEXT_PUBLIC_API_URL or NEXT_PUBLIC_SITE_URL is missing or points at
 * localhost -- and next.config.ts imports it, so that throw happens before
 * any code in this file runs. These rules are therefore usually unreachable
 * during a real boot, and that is fine: they exist so
 * `scripts/check-env.mjs --env render` can answer "would this pass in
 * production?" from a laptop WITHOUT importing the web config and throwing.
 *
 * @type {EnvRule[]}
 */
export const WEB_ENV_CONTRACT = [
  {
    name: "APP_ENV",
    secret: false,
    why: "States which environment this is instead of leaving it inferred.",
    emptyMeans: null,
    devValue: "localhost",
    check: isOneOf([...DEPLOY_ENVIRONMENTS]),
  },
  {
    name: "NEXT_PUBLIC_API_URL",
    secret: false,
    why: "The origin every visitor's browser fetches products from, and the value connect-src is derived from — a wrong one misdirects and blocks at once.",
    emptyMeans: null,
    devValue: DEV_API_URL,
    check: isUrl(["http:", "https:"]),
    perEnvironment: { render: all(notLoopback, mustBeHttps) },
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    secret: false,
    why: "Canonical URLs, hreflang alternates and OpenGraph images are all built from it.",
    emptyMeans: null,
    devValue: DEV_SITE_URL,
    check: all(isUrl(["http:", "https:"]), noTrailingSlash),
    perEnvironment: { render: all(notLoopback, mustBeHttps) },
  },
  {
    name: "NEXT_PUBLIC_BLOB_BASE_URL",
    secret: false,
    why: "The public base for product images; without it they resolve against the app's own origin.",
    emptyMeans:
      "images are served from this app's own origin — the real state on a " +
      "laptop and in CI, where no object storage exists",
    devValue: DEV_BLOB_BASE_URL,
    check: all(isUrl(["http:", "https:"]), noTrailingSlash),
    perEnvironment: { render: mustBeHttps },
  },
  {
    name: "SOURCEMAP_SIGNING_KEY",
    secret: true,
    why: "Signs source-map access tokens.",
    emptyMeans:
      "source maps are unavailable — the /sourcemaps route fails closed, " +
      "which is the safe state rather than a broken one",
    devValue: "",
    check: atLeast(32),
  },
];

export const CONTRACTS = { api: API_ENV_CONTRACT, web: WEB_ENV_CONTRACT };

export const CROSS_CHECKS = {
  api: [
    // The documented known-bad pairing: free-form ON with no template sends a
    // request Meta is known to reject, and marks every inquiry FAILED.
    (env) =>
      env.WHATSAPP_ALLOW_FREE_FORM === "true" && !env.WHATSAPP_TEMPLATE_NAME
        ? {
            level: "error",
            message:
              'WHATSAPP_ALLOW_FREE_FORM is "true" with no WHATSAPP_TEMPLATE_NAME. ' +
              "That combination sends a request Meta rejects and marks every inquiry FAILED. " +
              "Free-form is an opt-in for a known-open 24h window, never a fallback for a missing template.",
          }
        : null,

    // Configured to send, but unable to: the token is present so the code
    // will attempt delivery, and every attempt is refused before the request.
    (env) =>
      env.WHATSAPP_ACCESS_TOKEN &&
      !env.WHATSAPP_TEMPLATE_NAME &&
      env.WHATSAPP_ALLOW_FREE_FORM !== "true"
        ? {
            level: "error",
            message:
              "WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_TEMPLATE_NAME is not. " +
              "Delivery will be refused for every inquiry — business-initiated messages need a pre-approved template.",
          }
        : null,

    // A non-local blob provider without credentials fails at the first
    // upload, not at boot, so it survives a deploy and surfaces as a broken
    // seller action much later.
    (env) => {
      const provider = env.BLOB_PROVIDER || "local";
      if (provider === "local") return null;
      const missing = [
        "BLOB_ACCESS_KEY_ID",
        "BLOB_SECRET_ACCESS_KEY",
      ].filter((name) => !env[name]);
      return missing.length
        ? {
            level: "error",
            message: `BLOB_PROVIDER is "${provider}" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. Uploads would fail at the first write, not at boot.`,
          }
        : null;
    },

    // Trusting proxy headers asserts the origin refuses non-proxied traffic.
    // It cannot be verified from here, so it is surfaced rather than judged.
    (env, environment) =>
      env.INQUIRY_TRUST_PROXY_HEADERS === "true" && environment !== "render"
        ? {
            level: "warning",
            message:
              'INQUIRY_TRUST_PROXY_HEADERS is "true" outside Render. ' +
              "cf-connecting-ip is only trustworthy when every route to this origin goes through Cloudflare; " +
              "anywhere else the caller can set it themselves.",
          }
        : null,
  ],

  web: [
    // The failure this whole module exists for. Both variables have localhost
    // defaults, so the value being *present but wrong* looks identical to
    // healthy right up until a crawler indexes localhost.
    (env, environment) => {
      if (environment !== "render") return null;
      const offenders = ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_URL"].filter(
        (name) => {
          const value = env[name];
          if (!value) return false;
          try {
            return ["localhost", "127.0.0.1", "::1"].includes(
              new URL(value).hostname,
            );
          } catch {
            return false;
          }
        },
      );
      return offenders.length
        ? {
            level: "error",
            message: `${offenders.join(" and ")} point at localhost while running on Render. Visitors' browsers would resolve that to their own machine.`,
          }
        : null;
    },

    (env, environment) => {
      if (environment !== "render") return null;
      const insecure = [
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_SITE_URL",
        "NEXT_PUBLIC_BLOB_BASE_URL",
      ].filter((name) => env[name]?.startsWith("http://"));
      return insecure.length
        ? {
            level: "error",
            message: `${insecure.join(", ")} use http:// on Render. HSTS is served with a two-year max-age, so a plain-http origin is unreachable for any returning visitor.`,
          }
        : null;
    },
  ],
};

// ---------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------

/**
 * @typedef {object} Finding
 * @property {"error" | "warning"} level
 * @property {string} message
 */

/**
 * @typedef {object} CheckResult
 * @property {DeployEnvironment} environment
 * @property {"api" | "web"} app
 * @property {Finding[]} errors
 * @property {Finding[]} warnings
 * @property {boolean} ok
 */

/**
 * Checks one app's contract against an environment.
 *
 * Pure: takes the environment as an argument and returns findings. It never
 * reads process.env implicitly, never logs, and never exits — so the same
 * function backs the CLI, the API's boot check and the tests, rather than
 * three implementations that drift.
 *
 * @param {{app: "api" | "web", env?: Record<string, string | undefined>, environment?: DeployEnvironment}} options
 * @returns {CheckResult}
 */
export function checkEnv({ app, env = process.env, environment }) {
  const target = environment ?? detectEnvironment(env);
  const rules = CONTRACTS[app];
  if (!rules) throw new Error(`Unknown app "${app}" — expected api or web`);

  /** @type {Finding[]} */
  const errors = [];
  /** @type {Finding[]} */
  const warnings = [];

  // A TYPO IN APP_ENV IS A HARD ERROR, never a silent downgrade.
  //
  // detectEnvironment() ignores an unrecognised value and carries on
  // inferring, so a bad override cannot crash a tool that only wanted to
  // print a report. But "ignored" must not mean "unnoticed": APP_ENV exists
  // to state the environment outright, and `APP_ENV=prod` quietly getting
  // localhost's rules is the failure this module exists to remove.
  const override = env[APP_ENV_OVERRIDE];
  if (override && !DEPLOY_ENVIRONMENTS.includes(override)) {
    errors.push({
      level: "error",
      message:
        `${APP_ENV_OVERRIDE} is set to ${JSON.stringify(override)}, which is not a ` +
        `known environment. It was IGNORED and the environment was inferred as ` +
        `"${target}" instead — which may be more permissive than you intended. ` +
        `Use one of: ${DEPLOY_ENVIRONMENTS.join(", ")}.`,
    });
  }

  if (target === "unknown") {
    warnings.push({ level: "warning", message: UNKNOWN_ENVIRONMENT_HINT });
  }

  for (const rule of rules) {
    const raw = env[rule.name];

    // ABSENT: nobody declared it. Always an error -- every environment
    // declares every variable, so this means the environment is incomplete
    // rather than that the variable does not apply here.
    if (raw === undefined) {
      errors.push({
        level: "error",
        message:
          `${rule.name} is not declared. Every environment declares every variable — ` +
          `${rule.why}` +
          (rule.emptyMeans
            ? ` Set it to empty (${rule.name}=) to mean: ${rule.emptyMeans}.`
            : ""),
      });
      continue;
    }

    // EMPTY: a value, not an absence -- but only where that is documented.
    // A blank JWT_SECRET is not a decision anybody made on purpose.
    if (raw === "") {
      if (!rule.emptyMeans) {
        errors.push({
          level: "error",
          message: `${rule.name} is declared but empty, and empty is not a valid value for it. ${rule.why}`,
        });
      }
      continue;
    }

    // A placeholder is an ERROR in production and a WARNING elsewhere: the
    // dev stack ships `dev-secret-change-me` on purpose.
    if (looksLikePlaceholder(raw) && target !== "render") {
      warnings.push({
        level: "warning",
        message:
          `${rule.name} still looks like a placeholder` +
          (rule.secret ? " (value not shown — this variable is a secret)." : `. Found: ${JSON.stringify(raw)}`),
      });
    }

    const problem =
      universalProblem(raw) ??
      rule.check(raw) ??
      rule.perEnvironment?.[target]?.(raw) ??
      null;
    if (!problem) continue;

    // The value is only shown for a non-secret rule -- these messages are
    // printed into deploy logs and CI output.
    errors.push({
      level: "error",
      message: rule.secret
        ? `${rule.name} ${problem}. (Value not shown — this variable is a secret.)`
        : `${rule.name} ${problem}. Found: ${JSON.stringify(raw)}`,
    });
  }

  for (const cross of CROSS_CHECKS[app] ?? []) {
    const finding = cross(env, target);
    if (!finding) continue;
    (finding.level === "error" ? errors : warnings).push(finding);
  }

  return { environment: target, app, errors, warnings, ok: errors.length === 0 };
}

/**
 * How a value is shown in the startup banner.
 *
 * A SECRET IS NEVER PRINTED, not even partially. A masked prefix looks
 * helpful and is not: it narrows a brute-force and, worse, it is exactly the
 * kind of thing that gets pasted into a bug report. The banner's job is to
 * answer "is this set, and to what shape" -- for a secret, "set" is the whole
 * answer. Length is shown because a wrong-length secret is a real and common
 * misconfiguration, and length alone reveals nothing usable.
 *
 * @param {EnvRule} rule
 * @param {string | undefined} raw
 */
export function displayValue(rule, raw) {
  if (raw === undefined) return "(not declared)";
  if (raw === "") return "(empty)";
  if (rule.secret) return `*** (${raw.length} chars)`;
  return raw;
}

/**
 * The startup banner: which environment this is, and every variable's value.
 *
 * Printed on EVERY boot, not only on failure. The question "what is this
 * process actually configured with" is asked far more often than "is the
 * configuration valid", and answering it needs no debugging session, no shell
 * on the box and no guessing about which .env won.
 *
 * @param {CheckResult} result
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function formatStartupBanner(result, env) {
  const rules = CONTRACTS[result.app];
  const nameWidth = Math.max(...rules.map((r) => r.name.length));

  const title = `${result.app.toUpperCase()} starting — environment: ${result.environment}`;

  const rows = rules.map((rule) => {
    const raw = env[rule.name];
    const shown = displayValue(rule, raw);
    // A declared-empty value is legitimate but worth seeing at a glance, so
    // it carries what empty MEANS rather than just reading as blank.
    const note =
      raw === "" && rule.emptyMeans ? `  ← ${rule.emptyMeans.split(" — ")[0]}` : "";
    return `${rule.name.padEnd(nameWidth)}  ${shown}${note}`;
  });

  // Width from the widest ACTUAL line, so the box closes. Computing it from
  // the title alone left every row overflowing the right border, which looks
  // like a rendering bug and undermines the one job a banner has.
  const inner = Math.max(title.length, ...rows.map((r) => r.length)) + 2;
  const bar = "─".repeat(inner + 2);

  return [
    `┌${bar}┐`,
    `│  ${title.padEnd(inner)}│`,
    `├${bar}┤`,
    ...rows.map((r) => `│  ${r.padEnd(inner)}│`),
    `└${bar}┘`,
  ].join("\n");
}

/**
 * Renders a result for a terminal or a deploy log.
 *
 * @param {CheckResult} result
 * @returns {string}
 */
export function formatReport(result) {
  const lines = [
    `Environment check — app: ${result.app}, environment: ${result.environment}`,
  ];

  for (const { message } of result.errors) lines.push(`  ERROR    ${message}`);
  for (const { message } of result.warnings) lines.push(`  WARNING  ${message}`);

  if (result.ok && result.warnings.length === 0) {
    lines.push("  OK — every variable is declared, and every value is valid.");
  } else if (result.ok) {
    lines.push(
      `  OK with ${result.warnings.length} warning(s) — nothing is missing or invalid.`,
    );
  } else {
    lines.push("");
    lines.push(
      `  Refusing to start: ${result.errors.length} problem(s) must be fixed.`,
    );
  }

  return lines.join("\n");
}

/**
 * Check, report, and stop the process if anything is wrong.
 *
 * Separate from `checkEnv` so the decision to terminate lives in exactly one
 * place and the pure function stays testable. Callers that must not exit
 * (tests, tooling) use `checkEnv` directly.
 *
 * @param {{app: "api" | "web", env?: Record<string, string | undefined>, exit?: (code: number) => never, log?: (message: string) => void}} options
 * @returns {CheckResult}
 */
export function assertEnvOrExit({
  app,
  env = process.env,
  exit = process.exit,
  log = console.error,
}) {
  const result = checkEnv({ app, env });

  // ONCE PER PROCESS. Next loads next.config.ts more than once during a
  // build, so without this the banner appears several times in a row and
  // starts reading as noise -- which is how a startup diagnostic stops being
  // read at all. Keyed on a symbol rather than a module-level variable
  // because the config package can legitimately be loaded through more than
  // one specifier (the main entry, a subpath, a cache-busting query string in
  // tests) and each of those is a separate module instance.
  const printedKey = Symbol.for("@medinstru/config:banner-printed");
  const alreadyPrinted = Boolean(globalThis[printedKey]);
  globalThis[printedKey] = true;

  // The banner prints on EVERY boot, not only on failure. "What is this
  // process actually configured with" is asked far more often than "is the
  // configuration valid", and answering it in the first lines of the log
  // needs no shell on the box and no guessing about which .env won. Secrets
  // are shown as *** with a length and never partially -- see displayValue.
  if (!alreadyPrinted) log(formatStartupBanner(result, env));

  // Everything goes to stderr, warnings included. Render and GitHub Actions
  // both interleave the streams, and a startup diagnostic on stdout can be
  // swallowed by a process that pipes stdout somewhere.
  if (!result.ok || result.warnings.length > 0) log(formatReport(result));

  if (!result.ok) exit(1);
  return result;
}

// ---------------------------------------------------------------------
// Seeing the contract, not just enforcing it
// ---------------------------------------------------------------------

/**
 * What one environment must declare, and what the rules for its VALUES are.
 *
 * Every environment declares every variable, so the interesting question is
 * no longer "which variables apply here" -- it is "what counts as a valid
 * value here". This answers that.
 *
 * Derived, never a second table. A hand-maintained summary would drift from
 * the rules it summarises, silently, which is the failure this module exists
 * to remove.
 *
 * @param {"api" | "web"} app
 * @param {DeployEnvironment} environment
 */
export function expectationsFor(app, environment) {
  const rules = CONTRACTS[app];
  if (!rules) throw new Error(`Unknown app "${app}" — expected api or web`);
  if (!DEPLOY_ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}" — expected one of: ${DEPLOY_ENVIRONMENTS.join(", ")}`,
    );
  }

  return {
    /** Declared in every environment, without exception. */
    declared: rules.map((r) => r.name),
    /** May be declared empty here, and what empty means. */
    mayBeEmpty: rules
      .filter((r) => r.emptyMeans)
      .map((r) => ({ name: r.name, means: r.emptyMeans })),
    /** Carries an extra value rule in THIS environment. */
    extraValueRules: rules
      .filter((r) => r.perEnvironment?.[environment])
      .map((r) => r.name),
  };
}

/**
 * The whole contract as one readable table.
 *
 * One row per variable, because there is one variable list. The columns are
 * what actually varies: whether empty is a legal value, and which
 * environments constrain the value further.
 *
 * @param {"api" | "web"} app
 * @returns {string}
 */
export function formatMatrix(app) {
  const rules = CONTRACTS[app];
  if (!rules) throw new Error(`Unknown app "${app}" — expected api or web`);

  const rows = rules.map((rule) => ({
    name: rule.name,
    empty: rule.emptyMeans ? "allowed" : "no",
    secret: rule.secret ? "yes" : "",
    extra: DEPLOY_ENVIRONMENTS.filter((e) => rule.perEnvironment?.[e]).join(", "),
  }));

  const w = (key, header) =>
    Math.max(header.length, ...rows.map((r) => r[key].length));
  const widths = {
    name: w("name", "variable"),
    empty: w("empty", "empty ok"),
    secret: w("secret", "secret"),
    extra: w("extra", "stricter in"),
  };

  const line = (name, empty, secret, extra) =>
    [
      name.padEnd(widths.name),
      empty.padEnd(widths.empty),
      secret.padEnd(widths.secret),
      extra,
    ]
      .join("  ")
      .trimEnd();

  const header = line("variable", "empty ok", "secret", "stricter in");

  return [
    `${app}: every environment declares every one of these`,
    "",
    header,
    "-".repeat(header.length),
    ...rows.map((r) => line(r.name, r.empty, r.secret, r.extra)),
    "",
    "empty ok    = `NAME=` is a legal value here and means something specific;",
    "              see the rule's emptyMeans. Absent is ALWAYS an error.",
    "secret      = never printed; the startup banner shows *** and a length.",
    "stricter in = environments that constrain the VALUE further (for example",
    "              rejecting a localhost URL in production).",
  ].join("\n");
}

// ---------------------------------------------------------------------
// Generating the files that cannot import this one
// ---------------------------------------------------------------------

/** Wrap prose to a column, so generated comments do not run off the screen. */
function wrap(text, width = 74) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Render an app's `.env.example` from the contract.
 *
 * THE POINT: .env.example was the last hand-maintained copy of the variable
 * list, and a copy is a thing that drifts. Generating it means the contract is
 * the only place a variable is declared, described, or given a development
 * value -- add a rule and the example file follows, including its comment.
 *
 * `scripts/generate-env-example.mjs --check` fails when the committed file
 * differs from what this produces, so the generated output cannot rot either.
 *
 * @param {"api" | "web"} app
 * @returns {string}
 */
export function renderEnvExample(app) {
  const rules = CONTRACTS[app];
  if (!rules) throw new Error(`Unknown app "${app}" — expected api or web`);

  const lines = [
    `# apps/${app} environment variables — GENERATED, do not edit by hand.`,
    "#",
    "# Regenerate with:  node scripts/generate-env-example.mjs",
    "# Source of truth:  packages/config/src/env-contract.js",
    "#",
    "# HOW THIS FILE IS USED:",
    ...(app === "api"
      ? [
          "#   * You:    cp apps/api/.env.example apps/api/.env  (dotenv loads it at boot)",
          "#   * CI:     the API jobs run `cp .env.example .env` VERBATIM, so whatever",
          "#             is written here IS the configuration those jobs run under.",
          "#   * Docker: docker-compose.yml points at this file directly via env_file,",
          "#             overriding only the hostnames that differ inside the network.",
          "#   * Prod:   nothing reads this file. Render injects real values.",
        ]
      : [
          "#   * You:    cp apps/web/.env.example apps/web/.env  (Next loads it itself)",
          "#   * CI:     NOT copied — ci.yml declares these at workflow level so one",
          "#             block feeds all six steps that build or boot the web app.",
          "#   * Docker: docker-compose.yml points at this file via env_file.",
          "#   * Prod:   nothing reads this file. Render injects real values — and for",
          "#             NEXT_PUBLIC_*, they must ALSO be passed as Docker build args,",
          "#             because those are inlined into the client bundle at build time.",
        ]),
    "#",
    "# EVERY environment declares EVERY variable; only the VALUES differ. An",
    "# ABSENT variable is an error. An EMPTY one (`NAME=`) is a real value",
    "# meaning \"off\", and each one below says what off means.",
    "#",
    "# NAMES ONLY, never real values for anything secret — this file is",
    "# committed, and a committed credential is permanent in git history.",
    "",
  ];

  for (const rule of rules) {
    lines.push(...wrap(rule.why).map((l) => `# ${l}`));
    if (rule.emptyMeans) {
      lines.push("#");
      lines.push(...wrap(`EMPTY means: ${rule.emptyMeans}`).map((l) => `# ${l}`));
    }
    if (rule.secret) {
      lines.push("#");
      lines.push("# SECRET — never commit a value here. The startup banner prints *** only.");
    }
    // Quoted so a value containing a space survives dotenv, and so an empty
    // value reads as a deliberate `NAME=""` rather than a truncated line.
    lines.push(`${rule.name}=${JSON.stringify(rule.devValue)}`);
    lines.push("");
  }

  return lines.join("\n");
}
