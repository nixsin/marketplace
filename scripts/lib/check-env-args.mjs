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

/** The subset that takes a value; the rest are booleans. */
const VALUED_FLAGS = ["--env"];

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

    // The remediation has to differ for the two kinds of flag. `--list=true`
    // was answered with `Use "--list true"`, which then parses `true` as the
    // positional app and fails with `Unknown app "true"` -- advice that
    // trades one error for another. Only `--env` takes a value.
    const remediation = VALUED_FLAGS.includes(base)
      ? `Use "${base} ${arg.slice(equals + 1)}", not "${arg}".`
      : `"${base}" takes no value — use "${base}" on its own, not "${arg}".`;

    return {
      ok: false,
      code: 2,
      message: KNOWN_FLAGS.includes(base)
        ? remediation
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
 * The split is BUILD versus DEV SERVER, not deployment versus laptop, and
 * that distinction is the whole content of this function:
 *
 *   test                       Vitest/Jest            -> test
 *   localhost                  `next dev`             -> development
 *   render, github-ci,         `next build`           -> production
 *   ci-local, unknown
 *
 * github-ci was development here and that was wrong: the only thing CI does
 * with a web env file is `next build`, which is production mode, so a dry
 * run against it validated `.env.development*` while the job it describes
 * reads `.env.production*`. ci-local and unknown go with it for the same
 * reason -- `CI=true pnpm build` and a bare `pnpm build` are both builds.
 *
 * `localhost` stays development because that is the one target whose
 * defining activity is the dev server. Someone asking about a local
 * production build has `--env unknown`, which is what such a process
 * actually detects as.
 *
 * Only the web app is affected: envFilesFor("api", ...) returns `.env`
 * whatever the mode, because Nest reads one file.
 *
 * @param {string} target One of DEPLOY_ENVIRONMENTS.
 * @returns {string} The NODE_ENV to select env files with.
 */
export function nodeEnvForTarget(target) {
  if (target === "test") return "test";
  if (target === "localhost") return "development";
  return "production";
}

/**
 * Expand `$VAR` / `${VAR}` the way Next does, over FILE-SOURCED values only.
 *
 * This is the piece that ends four rounds of getting expansion wrong, and
 * the reason it belongs here rather than in the contract is provenance:
 *
 *   * Next runs a web `.env` FILE through dotenv-expand, so `$PUBLIC_ORIGIN`
 *     in such a file is not the value the app sees, and judging the literal
 *     reports a working configuration as broken.
 *   * Nothing expands a value already in `process.env` -- the Render
 *     dashboard, a shell export, a Docker ENV. There the literal IS the
 *     value, so `SOURCEMAP_SIGNING_KEY=$KEY` is a four-character key and
 *     must be judged as one.
 *
 * checkEnv receives a flat object and cannot tell those apart. The LOADER
 * can, because it knows which keys its own file reads introduced -- so the
 * resolution happens here, before the contract ever sees the values, and the
 * contract keeps judging literals with no special case at all.
 *
 * The API is deliberately excluded: Nest's ConfigModule expands only with
 * `expandVariables`, which apps/api does not set, so its file values are
 * literal too.
 *
 * An UNRESOLVED reference is left as written rather than replaced with an
 * empty string. dotenv-expand would substitute nothing and hand the app a
 * silently empty value; leaving the text intact makes the contract's own
 * rules report it, which is the loud version of the same fact.
 *
 * `\\$` escapes, matching dotenv-expand.
 *
 * @param {string} value    The raw value read from a file.
 * @param {Record<string, string | undefined>} scope Where to resolve names.
 * @returns {string}
 */
export function expandValue(value, scope) {
  // ITERATED TO A FIXED POINT, because a reference can resolve to another
  // reference: `A=$B` with `B=https://example.com` means `$A` is a URL, and
  // a single pass returns `$B`. dotenv-expand resolves the chain, so a
  // single pass rejected an environment Next resolves fine.
  //
  // Bounded, because `A=$A` and `A=$B` / `B=$A` are self-referential and a
  // fixed point does not exist. Ten passes is far past any real chain; what
  // remains unresolved is left as written, which the contract then reports.
  let current = value;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = expandOnce(current, scope);
    if (next === current) break;
    current = next;
  }

  // THE UNESCAPE HAPPENS ONCE, AFTER the loop, and that ordering is the
  // whole reason it is separate. Consuming the backslash inside a pass turns
  // `\$B` into `$B`, which the NEXT pass then expands -- so adding iteration
  // silently broke escaping, and an escaped reference resolved to the very
  // value the author had escaped it to avoid. Leaving `\$` untouched during
  // expansion also makes it a fixed point, which is what lets the loop
  // terminate on it.
  return current.replace(/\\(\$)/g, "$1");
}

/**
 * One substitution pass. Split out so the loop above is readable and the
 * termination condition -- "a pass changed nothing" -- is explicit.
 *
 * @param {string} value
 * @param {Record<string, string | undefined>} scope
 * @returns {string}
 */
function expandOnce(value, scope) {
  return value.replace(
    // `${VAR}`, `${VAR:-default}`, `${VAR-default}`, and bare `$VAR`.
    /\\?\$(?:\{([A-Za-z_]\w*)(?::?-([^}]*))?\}|([A-Za-z_]\w*))/g,
    (match, braced, fallback, bare) => {
      // Left exactly as found, backslash included -- see the note in
      // expandValue about why the unescape cannot happen here.
      if (match.startsWith("\\")) return match;

      const name = braced ?? bare;
      const resolved = scope[name];

      // `:-` and `-` differ in dotenv-expand exactly as they do in a shell:
      // `:-` substitutes the default for unset OR empty, plain `-` only for
      // unset. The match tells them apart by whether a colon preceded the
      // dash, which is recovered from the raw text rather than a third
      // capture group.
      if (fallback !== undefined) {
        const colonForm = match.includes(":-");
        const useDefault =
          resolved === undefined || (colonForm && resolved === "");
        return useDefault ? fallback : resolved;
      }

      return resolved === undefined ? match : resolved;
    },
  );
}
