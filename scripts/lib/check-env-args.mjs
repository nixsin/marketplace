/**
 * Argument parsing for scripts/check-env.mjs.
 *
 * Extracted because it is the one non-trivial part of that CLI and it has
 * already been wrong twice: `--env`'s value was picked up as the positional
 * app name, and `--env` with nothing after it was read as `undefined`. Both
 * failed in ways that looked like a configuration problem rather than a
 * usage one -- `Unknown app "render"` for a perfectly good invocation.
 *
 * Returns a decision rather than acting on one, so the tests exercise the
 * real code path instead of a parallel copy of it.
 */

/** @typedef {"api" | "web"} App */

export const APPS = /** @type {const} */ (["api", "web"]);

/**
 * @param {string[]} argv                Arguments after the script name.
 * @param {readonly string[]} environments  Accepted `--env` values.
 * @returns {{ok: true, apps: App[], forced?: string, list: boolean, show: boolean}
 *          | {ok: false, message: string, code: number}}
 */
const KNOWN_FLAGS = ["--env", "--list", "--show"];

export function parseArgs(argv, environments) {
  // AN UNKNOWN FLAG IS A REFUSAL, not something to skip past. Every flag
  // here selects a different operation, so silently ignoring one runs the
  // wrong operation and reports success: `--lis` checks the current
  // environment instead of listing, and `--showw` boots nothing while
  // looking like it printed the banner. A typo in a flag is exactly the
  // case where the reader trusts the output most.
  //
  // `--env=render` is called out by name because it is the form people
  // actually type, and it is the worst of the silent cases: it parses as an
  // unknown flag, leaves `forced` undefined, and checks the environment you
  // are in rather than the one you asked about -- which is the single
  // question this CLI exists to answer differently.
  for (const arg of argv) {
    if (!arg.startsWith("-")) continue;
    if (KNOWN_FLAGS.includes(arg)) continue;
    const equals = arg.indexOf("=");
    const base = equals === -1 ? arg : arg.slice(0, equals);
    return {
      ok: false,
      code: 2,
      message: KNOWN_FLAGS.includes(base)
        ? `Use "${base} ${arg.slice(equals + 1)}", not "${arg}".`
        : `Unknown option "${arg}". Expected ${KNOWN_FLAGS.join(", ")}.`,
    };
  }

  // A REPEATED FLAG IS A REFUSAL, for the same reason an unknown one is:
  // only the first `--env` is read, so `--env render --env localhost`
  // silently answers a different question than the one typed, and
  // `--env render --env` leaves a trailing incomplete option that the
  // positional logic then misreads. Neither should look like success.
  for (const flag of KNOWN_FLAGS) {
    if (argv.filter((a) => a === flag).length > 1) {
      return {
        ok: false,
        code: 2,
        message: `"${flag}" given more than once. Pass it at most once.`,
      };
    }
  }

  const envFlag = argv.indexOf("--env");
  if (envFlag !== -1) {
    const value = argv[envFlag + 1];
    if (!value || value.startsWith("-")) {
      return {
        ok: false,
        code: 2,
        message: "--env needs a value, e.g. --env render",
      };
    }
    if (!environments.includes(value)) {
      return {
        ok: false,
        code: 2,
        message: `Unknown --env "${value}". Expected one of: ${environments.join(", ")}`,
      };
    }
  }

  const forced = envFlag === -1 ? undefined : argv[envFlag + 1];

  // The value belonging to `--env` is NOT the positional app.
  //
  // Guarded on `envFlag !== -1`: with no `--env` present, envFlag is -1 and
  // `envFlag + 1` is 0, so this filter silently dropped the FIRST positional
  // argument -- `check-env.mjs mobile` was read as no app at all, and
  // `api web` as just `web`. Found by the tests this file was extracted for.
  const envValueIndex = envFlag === -1 ? -1 : envFlag + 1;
  const positional = argv.filter(
    (arg, i) => !arg.startsWith("-") && i !== envValueIndex,
  );

  if (positional.length > 1) {
    return {
      ok: false,
      code: 2,
      message: `Expected one app, got ${positional.length}: ${positional.join(", ")}`,
    };
  }

  const target = positional[0] ?? "all";
  if (target !== "all" && !APPS.includes(/** @type {App} */ (target))) {
    return {
      ok: false,
      code: 2,
      message: `Unknown app "${target}". Expected ${APPS.join(", ")}, or all.`,
    };
  }

  return {
    ok: true,
    apps: target === "all" ? [...APPS] : [/** @type {App} */ (target)],
    forced,
    list: argv.includes("--list"),
    show: argv.includes("--show"),
  };
}

/**
 * Which .env files does this app actually read, in precedence order?
 *
 * Extracted from check-env.mjs's loader for the reason everything else in
 * this directory is: it is a DECISION, and a decision inline in a CLI is one
 * nothing can test. The loader keeps the I/O; this answers the question.
 *
 * The two apps genuinely differ, and a checker that reads files the
 * application does not is worse than no checker -- it reports a valid
 * configuration sourced from somewhere the service will never look.
 *
 *   api -- `ConfigModule.forRoot({ isGlobal: true })` with no envFilePath,
 *          which is Nest's default of `.env` alone.
 *   web -- Next's order, highest precedence first.
 *
 * `.env.local` is skipped when NODE_ENV is `test`, matching Next, so a
 * developer's local overrides cannot change what a test run sees.
 *
 * @param {App} app
 * @param {string} nodeEnv
 * @returns {string[]} Filenames, highest precedence first.
 */
export function envFilesFor(app, nodeEnv) {
  if (app !== "web") return [".env"];

  // NEXT ONLY EVER USES THESE THREE MODES, and it sets NODE_ENV itself:
  // `next dev` forces development, `next build`/`next start` production,
  // and the test runners test. Interpolating whatever is in the environment
  // meant `NODE_ENV=staging` sent this looking for `.env.staging.local` --
  // a file Next would never read, so the checker would report values from
  // somewhere the app does not look, which is the exact failure the per-app
  // split above exists to prevent. Anything else falls back to production,
  // matching what Next does with an unrecognised mode.
  const mode = ["development", "production", "test"].includes(nodeEnv)
    ? nodeEnv
    : "production";

  return [
    `.env.${mode}.local`,
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}`,
    ".env",
  ];
}

/**
 * Which NODE_ENV does a given environment actually run Next in?
 *
 * `--env render` asks "would this pass in production?" -- and answering it
 * with the development .env files answers a different question. A Render
 * build runs `next build`, which is NODE_ENV=production, so it reads
 * `.env.production*`; checking `.env.development*` against production rules
 * reports a verdict about files that deploy will never open.
 *
 * The mapping is what each environment genuinely does, not a preference:
 *
 *   render      `next build` / `next start`      -> production
 *   unknown     a production-looking process      -> production
 *   test        Vitest/Jest                       -> test
 *   github-ci   \
 *   ci-local     > a dev server or a script       -> development
 *   localhost   /
 *
 * github-ci is the loose one: a CI job runs builds AND tests. `test` beats
 * both CI branches during detection, so a forced `github-ci` is asking about
 * the non-test jobs, which run a dev-mode toolchain.
 *
 * @param {string} target One of DEPLOY_ENVIRONMENTS.
 * @returns {string} The NODE_ENV to select env files with.
 */
export function nodeEnvForTarget(target) {
  if (target === "render" || target === "unknown") return "production";
  if (target === "test") return "test";
  return "development";
}
