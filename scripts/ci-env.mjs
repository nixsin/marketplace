#!/usr/bin/env node
/**
 * Emit an app's environment as `NAME=value` lines for GitHub Actions.
 *
 *   node scripts/ci-env.mjs web >> "$GITHUB_ENV"
 *
 * WHY THIS EXISTS: ci.yml was the last file carrying hand-written copies of
 * the variable values. GitHub Actions has no `env_file`, so the values had to
 * be declared inline and held in step by a drift test -- and a test catches
 * drift rather than preventing it, which means the drift it catches has
 * already been committed.
 *
 * TWO CONSTRAINTS SHAPE THIS SCRIPT, and both are why it is not a `cat`:
 *
 * 1. IT MUST RUN WITHOUT node_modules. `docker-scan` and
 *    `docker-web-prod-boot` only run `actions/checkout` -- no pnpm, no
 *    install -- so this imports the contract by RELATIVE PATH rather than as
 *    `@medinstru/config/env-contract`. The config package has no external
 *    imports, so a bare `node` on the runner can load it.
 *
 * 2. IT MUST NOT EMIT QUOTES. `.env.example` quotes its values, and
 *    $GITHUB_ENV takes everything after the first `=` literally -- so piping
 *    the file through would set APP_ENV to `"localhost"` WITH the quotes, and
 *    the environment check would then reject it as a value wrapped in quotes.
 *    Reading the contract's own values sidesteps the parsing entirely.
 *
 * APP_ENV is overridden to `github-ci`, because that is what this environment
 * actually is -- the contract's devValue describes a laptop.
 */
import { API_ENV_CONTRACT, WEB_ENV_CONTRACT } from "../packages/config/src/env-contract.js";

const CONTRACTS = { api: API_ENV_CONTRACT, web: WEB_ENV_CONTRACT };

const app = process.argv[2];
const rules = CONTRACTS[app];
if (!rules) {
  console.error(`Usage: node scripts/ci-env.mjs <api|web>  (got ${JSON.stringify(app)})`);
  process.exit(2);
}

for (const rule of rules) {
  const value = rule.name === "APP_ENV" ? "github-ci" : rule.devValue;

  // A newline would let one value forge another assignment -- the same shape
  // as log injection, applied to a file the runner trusts. No value in the
  // contract contains one today; refusing is cheaper than finding out.
  if (String(value).includes("\n")) {
    console.error(`${rule.name} contains a newline, which $GITHUB_ENV cannot take as a single line`);
    process.exit(1);
  }

  // Deliberately unquoted, and an empty value stays an empty assignment:
  // `NAME=` sets the variable to "", which is a real value in this contract
  // ("off") and must stay distinguishable from the variable being absent.
  console.log(`${rule.name}=${value}`);
}
