#!/usr/bin/env node
// CLI wrapper around pr-reconciliation.mjs's decideEnumeration — prints
// exactly one of: proceed | no-op | fail. See pr-reconciliation.yml's
// "Reconcile every open PR targeting main" step for how this is invoked.
import { decideEnumeration } from "./lib/pr-reconciliation.mjs";

const [lookupOkArg, prNumbersArg] = process.argv.slice(2);
if (lookupOkArg === undefined || prNumbersArg === undefined) {
  console.error("Usage: decide-enumeration.mjs <true|false> <space-separated-pr-numbers>");
  process.exit(1);
}

const lookupOk = lookupOkArg === "true";
const prNumbers = prNumbersArg.trim().length > 0 ? prNumbersArg.trim().split(/\s+/) : [];

console.log(decideEnumeration({ lookupOk, prNumbers }).action);
