#!/usr/bin/env node
/**
 * Check an app's environment variables and report what is wrong.
 *
 * This is the by-hand and CI entry point. It is NOT how the check runs in
 * production -- both prod images bypass npm scripts entirely (the API's CMD
 * is `node dist/src/main.js`, the web's is `next start`), so a `prestart`
 * hook would work locally and silently do nothing in the container. The real
 * enforcement lives in apps/api/src/main.ts and apps/web/next.config.ts,
 * which always run.
 *
 * All the decisions live in the environment contract, so this file and both
 * boot hooks share one implementation rather than three that drift.
 *
 * Imported by RELATIVE path for the same reason ci-env.mjs is: nothing under
 * scripts/ can rely on the workspace package being linked into the root
 * node_modules, and a checkout with no install must still be able to run it.
 *
 *   node scripts/check-env.mjs api
 *   node scripts/check-env.mjs web
 *   node scripts/check-env.mjs all
 *
 *   --env <environment>   Check AGAINST an environment you are not in.
 *                         Answers "would this pass on Render?" from a laptop,
 *                         which is the question worth asking before a deploy.
 *                         Different from APP_ENV, which changes what you ARE.
 *
 *   --list                Print the contract instead of checking anything:
 *                         every variable, whether empty is legal, which are
 *                         secret, and where the value rules are stricter.
 *
 *   --show                Print the startup banner -- every variable and its
 *                         current value, secrets masked -- without booting a
 *                         service.
 */
import {
  DEPLOY_ENVIRONMENTS,
  checkEnv,
  detectEnvironment,
  formatMatrix,
  formatReport,
  formatStartupBanner,
} from "../packages/config/src/env-contract.js";

const argv = process.argv.slice(2);

// The value belonging to `--env` is NOT the positional app.
//
// `argv.find(a => !a.startsWith("-"))` picked it whenever no app was given,
// so `check-env.mjs --env render` exited with `Unknown app "render"` instead
// of defaulting to `all`. Only worked at all because every documented
// invocation happens to put the app first.
const envFlag = argv.indexOf("--env");
if (envFlag !== -1 && !argv[envFlag + 1]) {
  console.error("--env needs a value, e.g. --env render");
  process.exit(2);
}
const forced = envFlag === -1 ? undefined : argv[envFlag + 1];

const positional = argv.filter(
  (arg, i) => !arg.startsWith("-") && i !== envFlag + 1,
);
const target = positional[0] ?? "all";
if (forced && !DEPLOY_ENVIRONMENTS.includes(forced)) {
  console.error(
    `Unknown --env "${forced}". Expected one of: ${DEPLOY_ENVIRONMENTS.join(", ")}`,
  );
  process.exit(2);
}

const apps = target === "all" ? ["api", "web"] : [target];

/**
 * Load the same .env the app itself loads at boot.
 *
 * Without this the CLI answers a question nobody asked: it reports what a
 * bare shell has, while apps/api reads apps/api/.env through dotenv and
 * apps/web has Next load apps/web/.env. Every variable would come back "not
 * declared" on a perfectly configured laptop, which trains people to ignore
 * it.
 *
 * `process.loadEnvFile` is built into Node, so this needs no dependency at
 * the workspace root -- and like dotenv it never overwrites a variable that
 * is already set, so an explicit `FOO=bar node scripts/check-env.mjs` still
 * wins over the file.
 */
function readAppEnv(app) {
  // NODE'S OWN PARSER, not a hand-rolled one.
  //
  // Three review rounds found three separate bugs in a hand-written parser --
  // trailing comments, escaped quotes, then backslash semantics -- and each
  // fix was correct without ending the class. A checker that parses .env
  // differently from the application reports errors nobody else sees and
  // misses ones everybody hits, so the only real fix is to stop having a
  // second parser at all.
  //
  // `process.loadEnvFile` mutates process.env and never overwrites an
  // existing value, so this snapshots, loads both files in dotenv's
  // precedence order (.env.local wins), captures the result, and restores --
  // which also keeps `check-env.mjs all` from letting the API's values leak
  // into the web app's report.
  const before = { ...process.env };
  try {
    for (const file of [".env.local", ".env"]) {
      try {
        process.loadEnvFile(new URL(`../apps/${app}/${file}`, import.meta.url));
      } catch {
        // Absent is a legitimate state -- CI and the containers declare their
        // values in the environment itself. The check reports what is missing.
      }
    }
    return { ...process.env };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    Object.assign(process.env, before);
  }
}
for (const app of apps) {
  if (app !== "api" && app !== "web") {
    console.error(`Unknown app "${app}". Expected api, web, or all.`);
    process.exit(2);
  }
}

if (argv.includes("--list")) {
  for (const app of apps) console.log(formatMatrix(app) + "\n");
  process.exit(0);
}

if (!forced) {
  console.log(`Detected environment: ${detectEnvironment()}`);
}

let failed = false;
for (const app of apps) {
  const env = readAppEnv(app);
  const result = checkEnv({ app, env, environment: forced });
  if (argv.includes("--show")) console.log(formatStartupBanner(result, env));
  console.log(formatReport(result));
  console.log("");
  if (!result.ok) failed = true;
}

process.exit(failed ? 1 : 0);
