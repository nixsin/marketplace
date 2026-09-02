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
 * 2. ONE VARIABLE LIST, SHARED BY EVERY ENVIRONMENT. Every environment
 *    declares every variable; what differs is the VALUE. A per-environment
 *    severity table let a variable be "required on render, optional
 *    elsewhere", which means it is invisible in the four environments where
 *    you would actually notice it missing -- you find out on the deploy.
 *    Absent is always an error; `""` is a value meaning "off", legal only
 *    where the rule's `emptyMeans` documents it and its `perEnvironment`
 *    rule does not refuse it.
 */

import {
  API_DEFAULT_PORT,
  DEV_API_URL,
  DEV_BLOB_BASE_URL,
  DEV_DATABASE_URL,
  DEV_SITE_URL,
  DEV_POSTGRES_DB,
  DEV_POSTGRES_PASSWORD,
  DEV_POSTGRES_USER,
  DOCKER_DATABASE_URL,
  DOCKER_REDIS_URL,
} from "./index.js";
import { isLoopbackHost, isPublicDnsName } from "./dns-name.js";

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
// The environment vocabulary and detection live in ./environment.js, shared
// with web-runtime.js so the two cannot disagree about what "on a
// deployment" means. Re-exported here because this is where callers look.
export {
  APP_ENV_OVERRIDE,
  DEPLOY_ENVIRONMENT,
  DEPLOY_ENVIRONMENTS,
  UNKNOWN_ENVIRONMENT_HINT,
  detectEnvironment,
  isDeployedEnvironment,
  isRenderDeploy,
} from "./environment.js";

import {
  APP_ENV_OVERRIDE,
  DEPLOY_ENVIRONMENTS,
  UNKNOWN_ENVIRONMENT_HINT,
  detectEnvironment,
} from "./environment.js";

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

  // AN AUTHORITY IS REQUIRED. WHATWG accepts `postgresql:foo` and
  // `redis:foo` as valid URLs with an empty hostname -- they parse, they
  // carry the right protocol, and they name no host to connect to. Every
  // rule below reads `hostname`, so without this they all silently pass on
  // the empty string.
  if (!parsed.hostname) {
    return "names no host — it needs an authority, as in scheme://host/path";
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
  // A DECIMAL DIGIT STRING, not merely something `Number()` accepts. `1e3`,
  // `0x10`, ` 80 ` and `080` all convert to a number in range here while
  // meaning something else -- or nothing -- to the several other parsers that
  // read this same variable: Node's own `listen()`, Docker's port mapping,
  // and Render's dashboard. The error text promises an integer, so the check
  // should demand one rather than whatever coercion happens to allow.
  if (!/^[1-9][0-9]*$/.test(value)) {
    return "must be an integer between 1 and 65535";
  }
  const n = Number(value);
  return n <= 65535 ? null : "must be an integer between 1 and 65535";
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
//
// WORD-BOUNDED, because the short terms match inside ordinary values:
// unanchored `todo` flags `https://todoapp.example.com`, and `fixme` would
// flag any host containing it. A false positive here is not harmless -- it
// refuses a deploy over a perfectly good value, which is how a check earns a
// reputation for crying wolf.
const PLACEHOLDER_PATTERN =
  /(\bchange[-_]?me\b|\byour[-_]?(key|secret|token|value|url)\b|\breplace[-_]?me\b|\btodo\b|\bfixme\b|xxxx+)/i;

/** @param {string} value */
function looksLikePlaceholder(value) {
  // The `<like-this>` case is tested WITHOUT a regex, and deliberately.
  //
  // This used to be a `<[^>]+>` alternative in the pattern above, which
  // CodeQL flagged as js/polynomial-redos (high): unanchored, the engine
  // retries `[^>]+` from every `<`, so input like "<<<<<<<<..." is quadratic.
  // Not reachable by an attacker here -- the input is an environment variable
  // an operator set -- but two index lookups answer exactly the same question
  // in linear time, so there is nothing to trade off.
  const open = value.indexOf("<");
  if (open !== -1 && value.indexOf(">", open + 1) !== -1) return true;

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

/**
 * Rejects an INTERNAL host that points at the machine asking.
 *
 * The weaker of the two checks, and deliberately so. Render's own Postgres
 * answers on `dpg-…-a` -- a single label with no dot -- so requiring a
 * public DNS name here would reject a perfectly good production database
 * URL. Only loopback is wrong, and in practice only `localhost`: it is what
 * a developer's .env says, and copying that into production is the mistake.
 */
const notLoopback = (value) => {
  let hostname;
  try {
    ({ hostname } = new URL(value));
  } catch {
    return null; // `check` already reports a malformed URL
  }
  return isLoopbackHost(hostname)
    ? "points at this machine — nothing in production can reach it"
    : null;
};

/**
 * Rejects a PUBLIC url that is not a resolvable name.
 *
 * The stronger check, for values a visitor's browser fetches. See
 * dns-name.js for why this is a name test rather than an IP-range test.
 */
const mustBePublicName = (value) => {
  let hostname;
  try {
    ({ hostname } = new URL(value));
  } catch {
    return null;
  }
  return isPublicDnsName(hostname)
    ? null
    : "must be a public DNS name in production — visitors reach it over the CDN, which needs a name it holds a certificate for";
};

/** Rejects plain http, which HSTS makes unreachable for returning visitors. */
const mustBeHttps = (value) => {
  // THE PARSED PROTOCOL, not a string prefix. `startsWith("http://")` is
  // case-sensitive, so `HTTP://example.com` walked straight past this while
  // isUrl() accepted it -- URL normalises the scheme to lowercase, so the two
  // checks disagreed about the same value.
  let protocol;
  try {
    ({ protocol } = new URL(value));
  } catch {
    return null; // `check` already reports a malformed URL
  }
  return protocol === "http:"
    ? "must use https:// in production — HSTS is served with a two-year max-age"
    : null;
};

/** Rejects a value nobody actually filled in. */
const notPlaceholder = (value) =>
  looksLikePlaceholder(value) ? "is still a placeholder" : null;

/**
 * A value that gets concatenated with paths must be a bare ORIGIN.
 *
 * A trailing slash was the only thing checked, which let
 * `https://laxair.shop?ref=x` and `https://laxair.shop/app` through -- both
 * produce `https://laxair.shop?ref=x/en` when a path is appended, a URL that
 * is neither the canonical page nor an error anyone would notice.
 */
const mustBeOrigin = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null; // `check` already reports a malformed URL
  }
  if (parsed.search || parsed.hash) {
    return "must not carry a query string or fragment — it is concatenated with paths";
  }
  return parsed.pathname === "/" && !value.endsWith("/")
    ? null
    : "must be a bare origin with no path and no trailing slash — it is concatenated with paths";
};

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
    devValue: DEV_DATABASE_URL,
    check: isUrl(["postgresql:", "postgres:"]),
    perEnvironment: { render: notLoopback },
  },
  {
    name: "JWT_SECRET",
    secret: true,
    why: "Signs session tokens. A guessable one is a full authentication bypass.",
    emptyMeans: null,
    devValue: "dev-secret-change-me",
    // The realistic production failure is not an absent secret but the
    // development one carried forward -- .env.example and docker-compose.yml
    // both ship `dev-secret-change-me`. No per-environment rule is needed:
    // checkEnv refuses ANY placeholder on render, for every variable.
    check: atLeast(16),
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
    perEnvironment: {
      // Empty stays legal here -- a null cache is a supported state, not a
      // degraded one, and the free Render plan is genuinely optional. What
      // is not legal is a NON-EMPTY value pointing at the container itself:
      // `redis://localhost:6379` on Render reaches nothing, so every read
      // fails and falls through to Postgres while the configuration insists
      // a cache is present. The honest states are "no cache configured" and
      // "a cache that resolves" -- this rules out the third.
      render: (value) => {
        if (value === "") return null;
        let host;
        try {
          host = new URL(value).hostname;
        } catch {
          return null; // `check` already reports a malformed URL
        }
        return isLoopbackHost(host)
          ? "must not point at localhost in production — it would reach the " +
            "API container itself, so every cache read fails. Leave it empty " +
            "for the supported no-cache state instead."
          : null;
      },
    },
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
      // an abuse control on an unauthenticated endpoint, and the whole reason
      // this module exists is that its absence is otherwise invisible.
      render: (value) =>
        value === ""
          ? "must not be empty in production — an unauthenticated endpoint with no per-IP limit is an abuse surface, and its absence is silent. Generate one with `openssl rand -hex 24`"
          : notPlaceholder(value),
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
    // NO per-environment rule refusing `local`, and that is a decision.
    //
    // The invariant is not "BLOB_PROVIDER must not be local in production" --
    // it is "never write data to storage the CDN does not serve", which
    // `local` violates only when something WRITES. Nothing in this app
    // injects BLOB_STORE yet, so refusing here would block a deploy over a
    // capability with zero call sites, and an error that cannot yet be true
    // is the kind people learn to route around.
    //
    // The refusal lives in createBlobStore()/LocalBlobStore.put() instead,
    // where it fires at the first upload on a deployment and cannot be
    // forgotten when uploads ship. This table still reports the state on
    // every boot -- see the startup banner -- so it is visible without
    // being fatal.
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
    check: all(isUrl(["http:", "https:"]), mustBeOrigin),
    perEnvironment: {
      // Empty is refused HERE despite `emptyMeans` documenting it, because
      // `emptyMeans` says empty is legal somewhere, not everywhere. In
      // production the link is the difference between a seller clicking
      // through and typing a search -- and inquiries.service.ts already
      // claimed this rule existed, which it did not.
      render: (value) =>
        value === ""
          ? "must not be empty in production — every outbound inquiry would omit the product link"
          : all(mustBePublicName, mustBeHttps)(value),
    },
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
    perEnvironment: {
      // REFUSED IN PRODUCTION, and this is where the "never a fallback"
      // rule actually bites. Free-form text is deliverable only inside a
      // 24-hour window the recipient opens by messaging the business first
      // — which never happens here, because the marketplace always speaks
      // first. So on Render the window is never open and every free-form
      // send is rejected by Meta. Locally it is legitimate: a developer who
      // has just messaged the test number really does have an open window.
      render: (value) =>
        value === "true"
          ? 'must not be "true" in production — every message here is ' +
            "business-initiated, so the 24h free-form window is never open " +
            "and Meta rejects every such send. Use WHATSAPP_TEMPLATE_NAME."
          : null,
    },
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
    perEnvironment: { render: all(mustBePublicName, mustBeHttps) },
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    secret: false,
    why: "Canonical URLs, hreflang alternates and OpenGraph images are all built from it.",
    emptyMeans: null,
    devValue: DEV_SITE_URL,
    check: all(isUrl(["http:", "https:"]), mustBeOrigin),
    perEnvironment: { render: all(mustBePublicName, mustBeHttps) },
  },
  {
    name: "NEXT_PUBLIC_BLOB_BASE_URL",
    secret: false,
    why: "The public base for product images; without it they resolve against the app's own origin.",
    emptyMeans:
      "images are served from this app's own origin — the real state on a " +
      "laptop and in CI, where no object storage exists",
    devValue: DEV_BLOB_BASE_URL,
    check: all(isUrl(["http:", "https:"]), mustBeOrigin),
    perEnvironment: {
      // Empty is refused in production despite `emptyMeans` documenting it:
      // that state means images resolve against the app's own origin rather
      // than the CDN, which is correct on a laptop and a silent regression
      // in production -- every product image served by Render instead of
      // Cloudflare, with nothing failing.
      //
      // The name and scheme checks matter here for the same reason as the
      // other two URLs: this one previously had only the scheme check, so
      // `https://localhost:9000` passed and every visitor's browser would
      // fetch product images from their own machine.
      render: (value) =>
        value === ""
          ? "must not be empty in production — product images would be served from the app's own origin instead of the CDN"
          : all(mustBePublicName, mustBeHttps)(value),
    },
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
    // Configured to send, but unable to: the token is present so the code
    // will attempt delivery, and every attempt is refused before the request.
    //
    // Free-form exempts this, matching `whatsapp.service.ts`, which refuses a
    // send only when the template AND free-form are both absent. Free-form
    // with no template is therefore a configuration the service supports --
    // the one this option exists for -- so it is not an error here. Whether
    // it is a sane thing to switch on is a per-environment question, and
    // WHATSAPP_ALLOW_FREE_FORM's own rule answers it: never on Render.
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

    // Delivery configured but incomplete. The token-without-template check
    // above covers one missing piece; the sender ID is the other, and its
    // rule permits empty ("delivery is off") so nothing else catches it.
    // Meta needs all three, so a partial set is a configuration that looks
    // enabled and cannot send.
    (env) =>
      env.WHATSAPP_ACCESS_TOKEN && !env.WHATSAPP_PHONE_NUMBER_ID
        ? {
            level: "error",
            message:
              "WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_PHONE_NUMBER_ID is empty. " +
              "Delivery needs the numeric sender ID as well as the token and template — " +
              "without it the configuration looks enabled and cannot send.",
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
            // displaySafe, not the raw value: this message goes to the same
            // logs as every other finding, and a cross-check is not exempt
            // from the sanitisation the per-variable path already applies.
            message: `BLOB_PROVIDER is ${JSON.stringify(displaySafe(provider))} but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. Uploads would fail at the first write, not at boot.`,
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
        `${APP_ENV_OVERRIDE} is set to ${JSON.stringify(displaySafe(override))}, which is not a ` +
        `known environment. It was IGNORED and the environment was inferred as ` +
        `"${target}" instead — which may be more permissive than you intended. ` +
        `Use one of: ${DEPLOY_ENVIRONMENTS.join(", ")}.`,
    });
  }

  // A CONTRADICTION IS REPORTED, not silently resolved. The platform marker
  // wins, but an APP_ENV claiming otherwise is a real misconfiguration --
  // usually a value copied from another environment -- and saying nothing
  // would leave someone reading APP_ENV and drawing the wrong conclusion.
  // ONLY when the target was DETECTED. `--env render` forces a target to ask
  // "would this pass there?" from a laptop -- where APP_ENV is legitimately
  // `localhost`. Comparing a forced target against APP_ENV reported a
  // contradiction with no platform involved, and broke the documented
  // dry-run workflow unless the operator edited their own .env first.
  const targetWasDetected = environment === undefined;
  if (
    targetWasDetected &&
    override &&
    override !== "unknown" &&
    DEPLOY_ENVIRONMENTS.includes(override) &&
    override !== target
  ) {
    errors.push({
      level: "error",
      message:
        `${APP_ENV_OVERRIDE} says "${override}" but this process is running on ` +
        `"${target}", which the platform reports directly. The platform wins. ` +
        `Fix ${APP_ENV_OVERRIDE}, because anything reading it is being misled.`,
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
        continue;
      }

      // THE PER-ENVIRONMENT RULE STILL RUNS ON AN EMPTY VALUE.
      //
      // It used to `continue` here, which made `perEnvironment` unreachable
      // for "" -- so INQUIRY_IP_HASH_SECRET could be empty in production,
      // silently disabling the per-IP rate limit on an unauthenticated
      // endpoint. That is the exact silent failure this module exists to
      // remove, reintroduced by the engine that enforces it.
      //
      // `emptyMeans` says empty is a legal value SOMEWHERE, not everywhere.
      // Where an environment cannot accept "off", its rule says so.
      const emptyProblem = rule.perEnvironment?.[target]?.(raw);
      if (emptyProblem) {
        errors.push({
          level: "error",
          message: `${rule.name} ${emptyProblem}. ${rule.why}`,
        });
      }
      continue;
    }

    // EMBEDDED CREDENTIALS IN A VALUE THAT GETS PRINTED.
    //
    // Checked here rather than inside isUrl(), because whether this is a
    // problem depends on the RULE, not the value: `user:password@host` is the
    // normal form of a Postgres or Redis connection string, and those are
    // marked secret so their values are never shown. It is only dangerous on
    // a non-secret rule, whose value the startup banner prints verbatim --
    // `https://user:password@example.com` would land in every boot log.
    if (!rule.secret && hasUrlCredentials(raw)) {
      errors.push({
        level: "error",
        message:
          `${rule.name} embeds credentials in its URL, and this variable's ` +
          `value is printed in the startup banner. Move the credential out, ` +
          `or the next boot log carries it. (Value not shown.)`,
      });
      continue;
    }

    // A placeholder is an ERROR in production and a WARNING elsewhere.
    //
    // The error half used to be missing: this only ever pushed a warning, and
    // only when NOT on render -- so production fell through to whichever
    // individual rules happened to list `notPlaceholder`, and
    // `WHATSAPP_ACCESS_TOKEN=change-me` sailed past. The claim in this very
    // comment was true of exactly one variable.
    if (looksLikePlaceholder(raw)) {
      const message =
        `${rule.name} still looks like a placeholder` +
        (rule.secret
          ? " (value not shown — this variable is a secret)."
          : `. Found: ${JSON.stringify(displaySafe(raw))}`);

      if (target === "render") {
        errors.push({ level: "error", message });
        continue;
      }
      // Elsewhere it is a warning: docker-compose.yml ships
      // `dev-secret-change-me` on purpose, and failing the dev stack for
      // using the value it is supposed to use helps nobody.
      warnings.push({ level: "warning", message });
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
        : `${rule.name} ${problem}. Found: ${JSON.stringify(displaySafe(raw))}`,
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
  // Credentials AND control characters -- see displaySafe.
  return displaySafe(raw);
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

/** Does this value parse as a URL carrying a username or password? */
function hasUrlCredentials(value) {
  try {
    const parsed = new URL(value);
    // No authority means an opaque URL, whose userinfo -- if any -- sits in
    // the pathname rather than in `username`/`password`. Same reasoning as
    // redactUrlCredentials: this is the catch block's question reached
    // through a successful parse.
    if (parsed.host === "") return /@/.test(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    // Same fail-closed reasoning as redactUrlCredentials: a value too
    // malformed to parse can carry userinfo in a shape no pattern reliably
    // describes, and answering "no" is how the leak got through.
    return /\/\/[^\s]*@/.test(value);
  }
}

/**
 * Replace any credentials embedded in a URL before the value is shown.
 *
 * Applied wherever a NON-SECRET value is printed -- the error text and the
 * startup banner. `isUrl` already refuses embedded credentials, but the rule
 * that fires is not always that one: a URL with a bad scheme AND a password
 * would be reported with the password intact, because the message includes
 * the raw value. Redacting at the point of display covers every path rather
 * than the one that happened to be considered.
 *
 * @param {string} value
 * @returns {string}
 */
export function redactUrlCredentials(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    // FAILS CLOSED ON ANYTHING UNPARSEABLE THAT COULD CARRY USERINFO.
    //
    // Three rounds went into widening a pattern here: it missed
    // username-only userinfo, then userinfo containing a slash, then a value
    // with no `//` at all (`not-a-url user:hunter2@`). Each fix was correct
    // and none ended the class, because every one of them still asked a
    // regex to recognise a shape that is malformed by definition.
    //
    // The question is not "does this look like userinfo" but "can I rule it
    // out". A bare `@` cannot be ruled out, so the whole value is withheld.
    // The variable name and the problem are still reported.
    return value.includes("@")
      ? "(redacted — unparseable value that may contain credentials)"
      : value;
  }
  // AN OPAQUE URL PARSES AND HAS NO AUTHORITY, so `username`/`password` are
  // empty however much userinfo the text contains -- `mailto:u:pw@h.com`
  // parses cleanly and puts the whole of `u:pw@h.com` in `pathname`. That is
  // the same question the catch block above answers, arriving through a
  // success rather than a failure, so it gets the same answer: a value with
  // no authority and a bare `@` cannot be ruled out, and is withheld.
  if (parsed.host === "") {
    return value.includes("@")
      ? "(redacted — value may contain credentials)"
      : value;
  }

  if (!parsed.username && !parsed.password) return value;
  parsed.username = "***";
  parsed.password = "";
  return parsed.toString();
}

/**
 * Make a value safe to print, whatever it is.
 *
 * THE SINGLE PLACE a non-secret value becomes display text, so the two
 * concerns that apply to every such value are handled together rather than
 * at each call site:
 *
 * 1. CREDENTIALS -- see redactUrlCredentials above.
 * 2. CONTROL CHARACTERS. The startup banner interpolates values into lines
 *    and draws a box around them, so a value containing a newline forges log
 *    lines and one containing an ANSI escape rewrites the terminal. Same
 *    reasoning as sanitizeForLog in the WhatsApp path, which strips
 *    `\p{Cf}` as well as `\p{Cc}` -- U+202E RIGHT-TO-LEFT OVERRIDE reverses
 *    a line visually, forging one just as effectively as an injected
 *    newline. `\p{Zl}` and `\p{Zp}` go with them: U+2028 LINE SEPARATOR and
 *    U+2029 PARAGRAPH SEPARATOR are categorised as separators rather than
 *    controls, so neither `Cc` nor `Cf` catches them, and both start a new
 *    line in a JSON log viewer and in a JavaScript string literal. The
 *    function's whole job is that no value can forge a line, so the
 *    category a character happens to sit in is beside the point.
 *
 * @param {string} value
 * @returns {string}
 */
export function displaySafe(value) {
  return redactUrlCredentials(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    "\uFFFD",
  );
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
    /**
     * May be declared empty HERE -- which is not the same as having an
     * `emptyMeans`. This filtered on that alone, so it listed
     * INQUIRY_IP_HASH_SECRET and NEXT_PUBLIC_SITE_URL as empty-capable on
     * render while their Render rules reject `""` -- the function's own
     * documentation says "here", and it was answering "anywhere".
     */
    mayBeEmpty: rules
      .filter((r) => r.emptyMeans && !r.perEnvironment?.[environment]?.(""))
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
    // "allowed" is not a property of the rule alone: INQUIRY_IP_HASH_SECRET
    // and NEXT_PUBLIC_SITE_URL both document an `emptyMeans` and both refuse
    // "" in production. Reporting them as globally empty-capable is the same
    // bug expectationsFor had -- answering "anywhere" while reading "here".
    empty: !rule.emptyMeans
      ? "no"
      : DEPLOY_ENVIRONMENTS.some((e) => rule.perEnvironment?.[e]?.(""))
        ? "not everywhere"
        : "allowed",
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
    "empty ok    = `NAME=` is a legal value and means something specific; see",
    "              the rule's emptyMeans. `not everywhere` means some",
    "              environment refuses it anyway -- production usually.",
    "              Absent is ALWAYS an error.",
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

/**
 * The Docker-network overrides, as a dotenv file.
 *
 * Exactly two variables differ inside the compose network: Postgres and Redis
 * answer on service names there, and a container cannot reach the host's
 * `localhost`. Everything else is identical to a laptop.
 *
 * Generated rather than written into docker-compose.yml, so the last two env
 * literals leave that file. Compose applies `env_file` entries in order, so
 * listing this one after `.env.example` lets it override those two and
 * nothing else -- and because both URLs are built from the same parts as
 * their localhost counterparts, the pair cannot drift apart while each keeps
 * working perfectly in its own context.
 *
 * @returns {string}
 */
export function renderDockerEnv() {
  return [
    "# GENERATED, do not edit by hand.",
    "#",
    "# Regenerate with:  node scripts/generate-env-example.mjs",
    "# Source of truth:  packages/config/src/index.js",
    "#",
    "# The ONLY variables that differ inside the Docker network. Listed after",
    "# .env.example in docker-compose.yml's env_file, so these two win and",
    "# every other value stays identical to a laptop's.",
    "",
    "# The Postgres container creates this account for itself on first boot,",
    "# and the API connects with it -- so both halves come from one definition",
    "# rather than a literal in the service block and another in the URL.",
    `POSTGRES_USER=${JSON.stringify(DEV_POSTGRES_USER)}`,
    `POSTGRES_PASSWORD=${JSON.stringify(DEV_POSTGRES_PASSWORD)}`,
    `POSTGRES_DB=${JSON.stringify(DEV_POSTGRES_DB)}`,
    "",
    "# Postgres answers on the compose service name, not the host's localhost.",
    `DATABASE_URL=${JSON.stringify(DOCKER_DATABASE_URL)}`,
    "",
    "# Redis likewise. Note this is NON-EMPTY here while .env.example leaves it",
    "# empty: the dev stack runs a real Redis, so the shared cache is on.",
    `REDIS_URL=${JSON.stringify(DOCKER_REDIS_URL)}`,
    "",
  ].join("\n");
}
