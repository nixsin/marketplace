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
export function parseArgs(argv, environments) {
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
