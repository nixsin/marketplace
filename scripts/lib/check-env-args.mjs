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
  return [
    `.env.${nodeEnv}.local`,
    ...(nodeEnv === "test" ? [] : [".env.local"]),
    `.env.${nodeEnv}`,
    ".env",
  ];
}
