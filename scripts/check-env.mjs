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
 * All the decisions live in @medinstru/config/env-contract, so this file and
 * both boot hooks share one implementation rather than three that drift.
 *
 *   node scripts/check-env.mjs api
 *   node scripts/check-env.mjs web
 *   node scripts/check-env.mjs all
 *
 *   --env <render|ci|test|local>   Check AGAINST a different environment than
 *                                  the one detected. Answers "would this pass
 *                                  on Render?" from a laptop, which is the
 *                                  question worth asking before a deploy.
 */
import {
  DEPLOY_ENVIRONMENTS,
  checkEnv,
  detectEnvironment,
  formatReport,
} from "@medinstru/config/env-contract";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("-")) ?? "all";

const envFlag = argv.indexOf("--env");
const forced = envFlag === -1 ? undefined : argv[envFlag + 1];
if (forced && !DEPLOY_ENVIRONMENTS.includes(forced)) {
  console.error(
    `Unknown --env "${forced}". Expected one of: ${DEPLOY_ENVIRONMENTS.join(", ")}`,
  );
  process.exit(2);
}

const apps = target === "all" ? ["api", "web"] : [target];
for (const app of apps) {
  if (app !== "api" && app !== "web") {
    console.error(`Unknown app "${app}". Expected api, web, or all.`);
    process.exit(2);
  }
}

if (!forced) {
  console.log(`Detected environment: ${detectEnvironment()}`);
}

let failed = false;
for (const app of apps) {
  const result = checkEnv({ app, environment: forced });
  console.log(formatReport(result));
  console.log("");
  if (!result.ok) failed = true;
}

process.exit(failed ? 1 : 0);
