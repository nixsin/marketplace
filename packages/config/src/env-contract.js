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
export const DEPLOY_ENVIRONMENTS = /** @type {const} */ ([
  "render",
  "github-ci",
  "ci-local",
  "test",
  "localhost",
  "unknown",
]);

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

// ---------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------

/**
 * `levels` is keyed by environment. Anything omitted defaults to "optional",
 * which keeps the tables readable: only deviations from "we do not care" are
 * written down.
 *
 * @typedef {object} EnvRule
 * @property {string} name
 * @property {boolean} secret        Never echo this value into a message.
 * @property {string} why            What actually breaks, in one line.
 * @property {Partial<Record<DeployEnvironment, Severity>>} levels
 * @property {(value: string) => string | null} [check]
 */

/** @type {EnvRule[]} */
export const API_ENV_CONTRACT = [
  {
    name: "DATABASE_URL",
    secret: true, // contains the password
    why: "Nothing works without it; Prisma cannot connect.",
    levels: {
      render: "required",
      localhost: "required",
      "github-ci": "required",
      "ci-local": "required",
    },
    check: isUrl(["postgresql:", "postgres:"]),
  },
  {
    name: "JWT_SECRET",
    secret: true,
    why: "Signs session tokens. A guessable one is a full authentication bypass.",
    // Not required in `test`: the e2e suite builds its own module fixtures.
    levels: {
      render: "required",
      localhost: "required",
      "github-ci": "required",
      "ci-local": "required",
    },
    check: atLeast(16),
  },
  {
    name: "PORT",
    secret: false,
    // Worth flagging even though it has a fallback, because the fallback is
    // actively wrong here: main.ts uses `process.env.PORT ?? 3000`, and 3000
    // is the WEB app's port. Unset locally, the API quietly binds the port
    // the web dev server wants, and the failure surfaces as the web app
    // refusing to start rather than as anything about the API.
    why: "Unset, the API falls back to 3000 — the web app's port.",
    levels: { localhost: "recommended" },
    check: isPort,
  },
  {
    name: "REDIS_URL",
    secret: true, // Render's connection string carries credentials
    why: "Absent, the shared cache silently does not run and every read hits Postgres.",
    // Deliberately NOT required anywhere. The API treats the cache as
    // optional by construction, `.env.example` ships it blank so CI's
    // `cp .env.example .env` does not point at a Redis no job runs, and a
    // bare checkout must work. On Render it is `recommended`, because there
    // it is Terraform-provisioned and its absence means the cache the
    // catalogue depends on is not actually wired up.
    levels: { render: "recommended" },
    check: isUrl(["redis:", "rediss:"]),
  },
  {
    name: "INQUIRY_IP_HASH_SECRET",
    secret: true,
    why: "Without it the per-IP rate limit does not run at all — silently, on an unauthenticated endpoint.",
    levels: { render: "required" },
    check: atLeast(16),
  },
  {
    name: "INQUIRY_TRUST_PROXY_HEADERS",
    secret: false,
    why: 'Only the exact string "true" enables it; anything else reads as off.',
    levels: {},
    check: isOneOf(["true", "false"]),
  },
  {
    name: "BLOB_PROVIDER",
    secret: false,
    why: "Defaults to `local`, which on Render writes uploads into the container filesystem — no CDN serves them and a redeploy discards them.",
    levels: { render: "required" },
    check: isOneOf(["r2", "s3", "b2", "spaces", "minio", "local"]),
  },
  {
    name: "BLOB_ACCESS_KEY_ID",
    secret: true,
    why: "Required once BLOB_PROVIDER is not `local`.",
    levels: {},
  },
  {
    name: "BLOB_SECRET_ACCESS_KEY",
    secret: true,
    why: "Required once BLOB_PROVIDER is not `local`.",
    levels: {},
  },
  {
    name: "WHATSAPP_ACCESS_TOKEN",
    secret: true,
    why: "Absent, inquiries are still recorded but never delivered to the seller.",
    levels: { render: "recommended" },
  },
  {
    name: "WHATSAPP_PHONE_NUMBER_ID",
    secret: false,
    why: "Absent, inquiries are still recorded but never delivered to the seller.",
    levels: { render: "recommended" },
  },
  {
    name: "WHATSAPP_TEMPLATE_NAME",
    secret: false,
    why: "Business-initiated WhatsApp messages REQUIRE a pre-approved template; free-form text is rejected outside a 24h window the buyer opens.",
    levels: {},
  },
  {
    name: "WHATSAPP_ALLOW_FREE_FORM",
    secret: false,
    why: "An opt-in for a known-open service window, never a fallback for a missing template.",
    levels: {},
    check: isOneOf(["true", "false"]),
  },
];

/**
 * NOTE ON ORDERING, so these rules are not mistaken for the only defence.
 *
 * On Render, `@medinstru/config` throws while it is being IMPORTED if
 * NEXT_PUBLIC_API_URL or NEXT_PUBLIC_SITE_URL is missing or points at
 * localhost — and next.config.ts imports it, so that throw happens before
 * any code in this file runs. These two rules are therefore usually
 * unreachable during a real boot, and that is fine: they exist so
 * `scripts/check-env.mjs --env render` can answer "would this pass on
 * Render?" from a laptop WITHOUT importing the web config and throwing.
 *
 * Three layers, deliberately, because each catches what the others cannot:
 * next.config.ts's siteUrlProblem (the richest message, private ranges and
 * embedded credentials included), the config's own throw (covers every
 * import path, not just next.config.ts), and this table (reports everything
 * at once, and can be run against an environment you are not in).
 *
 * @type {EnvRule[]}
 */
export const WEB_ENV_CONTRACT = [
  {
    name: "NEXT_PUBLIC_API_URL",
    secret: false,
    // The default is what makes this dangerous rather than obvious: a build
    // with no value produces a bundle that calls localhost:4000 from the
    // visitor's browser. It also feeds the CSP's connect-src, so a wrong
    // value blocks the requests as well as misdirecting them.
    why: "On Render the config REFUSES to fall back and throws; anywhere else it defaults to http://localhost:4000/graphql.",
    levels: { render: "required" },
    check: isUrl(["http:", "https:"]),
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    secret: false,
    why: "On Render the config REFUSES to fall back and throws; anywhere else it defaults to http://localhost:3000.",
    levels: { render: "required" },
    check: isUrl(["http:", "https:"]),
  },
  {
    name: "NEXT_PUBLIC_BLOB_BASE_URL",
    secret: false,
    why: "The public base for product images; without it they resolve against the app's own origin.",
    levels: { render: "recommended" },
    check: isUrl(["http:", "https:"]),
  },
  {
    name: "SOURCEMAP_SIGNING_KEY",
    secret: true,
    // Genuinely optional: the route fails closed, so unset means maps are
    // unavailable rather than public. That is the safe state, so its absence
    // is not even a warning -- only a malformed value is.
    why: "Unset means source maps are unavailable, which is the safe default. A short key weakens the signature.",
    levels: {},
    check: atLeast(32),
  },
];

export const CONTRACTS = { api: API_ENV_CONTRACT, web: WEB_ENV_CONTRACT };

// ---------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------

/**
 * Combinations, which a per-variable table cannot express. Each returns a
 * finding or null.
 *
 * These are where the genuinely damaging misconfigurations live: every one
 * of them is a state in which each individual variable looks fine.
 *
 * @type {Record<string, ((env: Record<string, string | undefined>, environment: DeployEnvironment) => {level: "error"|"warning", message: string} | null)[]>}
 */
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

  for (const rule of rules) {
    const severity = rule.levels[target] ?? "optional";
    const raw = env[rule.name];
    // An empty string is ABSENT, not present-and-blank. `.env.example` ships
    // several variables as `NAME=` on purpose, and dotenv loads those as "".
    // Treating that as set would report a blank JWT_SECRET as satisfied.
    const present = raw !== undefined && raw !== "";

    if (!present) {
      if (severity === "required") {
        errors.push({
          level: "error",
          message: `${rule.name} is not set. ${rule.why}`,
        });
      } else if (severity === "recommended") {
        warnings.push({
          level: "warning",
          message: `${rule.name} is not set. ${rule.why}`,
        });
      }
      continue;
    }

    if (!rule.check) continue;
    const problem = rule.check(raw);
    if (!problem) continue;

    // A malformed value is an ERROR at every severity, including "optional".
    // Absence and wrongness are different failures: absence is often a
    // deliberate, documented state, while a value that is present and
    // malformed is never intended by anyone.
    //
    // The value is only shown for a non-secret rule -- these messages are
    // printed into Render logs and CI output.
    errors.push({
      level: "error",
      message: rule.secret
        ? `${rule.name} ${problem}. (Value not shown — this variable is a secret.)`
        : `${rule.name} ${problem}. Found: ${JSON.stringify(raw)}`,
    });
  }

  // An unrecognised environment is not an error -- docker-web-prod-boot is a
  // legitimate one -- but it must never pass in silence, or "permissive by
  // default" becomes invisible exactly where it matters most.
  if (target === "unknown") {
    warnings.push({ level: "warning", message: UNKNOWN_ENVIRONMENT_HINT });
  }

  for (const cross of CROSS_CHECKS[app] ?? []) {
    const finding = cross(env, target);
    if (!finding) continue;
    (finding.level === "error" ? errors : warnings).push(finding);
  }

  return { environment: target, app, errors, warnings, ok: errors.length === 0 };
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
    lines.push("  OK — every variable this environment requires is set.");
  } else if (result.ok) {
    lines.push(
      `  OK with ${result.warnings.length} warning(s) — nothing required is missing.`,
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
  const report = formatReport(result);

  // Everything goes to stderr, warnings included. Render and GitHub Actions
  // both interleave the streams, and a startup diagnostic on stdout can be
  // swallowed by a process that pipes stdout somewhere.
  if (!result.ok || result.warnings.length > 0) log(report);

  if (!result.ok) exit(1);
  return result;
}
