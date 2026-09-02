/**
 * Which environment is this process running in?
 *
 * SEPARATE FROM THE CONTRACT, and that is not tidiness. Two consumers need
 * this and only this: env-contract.js, which picks rules by environment, and
 * web-runtime.js, which decides whether to enforce production URL rules.
 *
 * web-runtime had its own copy -- `RENDER === "true" || RENDER_GIT_COMMIT` --
 * which meant `APP_ENV=render` activated the contract's strict rules but not
 * its own, so the two modules disagreed about the same question. Sharing the
 * answer is the fix; importing the whole contract into web-runtime is not,
 * because apps/web pages import that module and it would carry 1,500 lines
 * of rule tables into the client bundle.
 */

/**
 * THE TYPEDEF LIVES HERE, not in env-contract.js, and the direction matters:
 * this module is the one that produces an environment, and env-contract.js
 * imports it. Declaring it there and using it here made the union unresolved
 * in this file for any JSDoc-aware checker -- and an unresolved type is not
 * a weaker check, it is no check, so the casts below were asserting nothing.
 *
 * Kept in step with DEPLOY_ENVIRONMENTS by a test, since a union written out
 * by hand and an array of the same strings drift silently in both
 * directions.
 *
 * @typedef {"render" | "github-ci" | "ci-local" | "test" | "localhost" | "unknown"} DeployEnvironment
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
  // Via detectEnvironment, NOT isRenderDeploy directly.
  //
  // `APP_ENV=render` is documented and tested as the way to state a
  // deployment when no platform marker is detectable -- but this used to ask
  // only about markers, so a process identified as production by APP_ENV
  // still got LocalBlobStore's write path enabled. Deployment-sensitive
  // callers must agree with detection, or "which environment am I" has two
  // answers depending on who asks.
  return detectEnvironment(env) === "render";
}

/**
 * Which environment is this process running in?
 *
 * ORDER IS LOAD-BEARING and every branch earns its place:
 *
 * 0. A PLATFORM MARKER first. `RENDER=true` is injected by the platform and
 *    cannot be stale, while `APP_ENV` is set by a person and can be -- so one
 *    leftover `APP_ENV=localhost` must not be able to disable every
 *    production rule. A contradiction between them is reported as an error
 *    rather than resolved silently.
 * 1. Then `APP_ENV`, which NARROWS rather than overrides: it can state an
 *    environment nothing can detect, which is the escape hatch for any host
 *    this function has never heard of. `unknown` is not an assertion and
 *    never wins.
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
  // `unknown` is NOT an assertion, so it does not win.
  //
  // apps/web/Dockerfile defaults `ARG APP_ENV=unknown`, so an image built
  // anywhere gets it. A Render build passes RENDER_GIT_COMMIT but need not
  // pass APP_ENV -- and with `unknown` treated as an override, that build
  // skipped every render-specific rule while a real platform marker sat
  // right there. An override says "I know where I am"; `unknown` says the
  // opposite, so a marker beats it.
  // A REAL PLATFORM MARKER BEATS APP_ENV. This ordering was the other way
  // round, and that was wrong in the dangerous direction: `RENDER=true` is
  // injected by the platform and cannot be stale, while APP_ENV is set by a
  // person and can be. Trusting the person over the platform meant one
  // leftover `APP_ENV=localhost` silently disabled every render-only rule --
  // including the refusal of the development JWT_SECRET and of an empty
  // INQUIRY_IP_HASH_SECRET. An override may narrow among environments nobody
  // can detect; it may not downgrade one the platform is telling us about.
  if (isRenderDeploy(env)) return "render";

  // `unknown` is not an assertion either, so it does not win. apps/web's
  // Dockerfile defaults `ARG APP_ENV=unknown`, so an image built anywhere
  // carries it; treating that as an override made a Render BUILD skip every
  // render rule while RENDER_GIT_COMMIT sat right there.
  const override = env[APP_ENV_OVERRIDE];
  const asserted =
    override &&
    override !== "unknown" &&
    DEPLOY_ENVIRONMENTS.includes(/** @type {any} */ (override));
  if (asserted) return /** @type {DeployEnvironment} */ (override);
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
  `and NODE_ENV is not development). Every variable is still required — one ` +
  `list is shared by every environment — but the stricter PRODUCTION value ` +
  `rules are not applied, so a localhost URL or a placeholder secret would ` +
  `pass here and fail on Render. If this is a real deployment, set ` +
  // NOT "unknown", which this list used to include. detectEnvironment
  // deliberately ignores that value -- it is not an assertion -- so telling
  // someone to set it sends them to change a variable, rerun, and get this
  // same warning back with nothing to show for it.
  `${APP_ENV_OVERRIDE} to one of: ` +
  `${DEPLOY_ENVIRONMENTS.filter((e) => e !== "unknown").join(", ")}.`;

