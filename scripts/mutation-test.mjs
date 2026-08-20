#!/usr/bin/env node
/**
 * Runs mutation testing over the guard/validator files that matter.
 *
 * Deliberately hand-rolled rather than Stryker: this needs to mutate four
 * files across two apps with two different test runners (vitest and jest),
 * and configuring Stryker for that is more moving parts than the ~80 lines
 * it replaces. If the target list grows much beyond this, reconsider.
 *
 *   node scripts/mutation-test.mjs            # all targets
 *   node scripts/mutation-test.mjs --file X   # one target
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MUTATION_TARGETS,
  OPERATORS,
  classifyMutant,
  formatMutationReport,
  summarizeMutants,
  MINIMUM_SCORE,
} from "./lib/mutation-testing.mjs";

const REPO = resolve(import.meta.dirname, "..");
const only = process.argv.includes("--file")
  ? process.argv[process.argv.indexOf("--file") + 1]
  : null;

/** Which suite covers a given source file. */
function suiteFor(file) {
  return file.startsWith("apps/api/")
    ? { cwd: join(REPO, "apps/api"), cmd: ["pnpm", ["exec", "jest", "--silent"]] }
    : { cwd: join(REPO, "apps/web"), cmd: ["pnpm", ["exec", "vitest", "run", "src/lib"]] };
}

function runSuite({ cwd, cmd }) {
  try {
    execFileSync(cmd[0], cmd[1], { cwd, stdio: "pipe", timeout: 300_000 });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stderr: String(error.stderr ?? "") };
  }
}

const results = [];

for (const target of MUTATION_TARGETS) {
  if (only && target.file !== only) continue;

  const path = join(REPO, target.file);
  const original = readFileSync(path, "utf8");
  const suite = suiteFor(target.file);

  console.log(`\n${target.file}  (${target.why})`);

  for (const op of OPERATORS) {
    const lines = original.split("\n");

    for (let i = 0; i < lines.length; i++) {
      // Skip comments and imports: mutating those proves nothing about
      // assertions and burns the budget.
      const line = lines[i];
      if (/^\s*(\/\/|\*|\/\*|import |export \{)/.test(line)) continue;
      if (!op.find.test(line)) continue;
      op.find.lastIndex = 0;

      const mutated = [...lines];
      mutated[i] = line.replace(op.find, op.replace);
      if (mutated[i] === line) continue;

      writeFileSync(path, mutated.join("\n"));
      const outcome = runSuite(suite);
      const status = classifyMutant(outcome);
      results.push({ file: target.file, line: i + 1, operator: op.name, status });

      process.stdout.write(
        status === "killed" ? "." : status === "invalid" ? "?" : "S",
      );
    }
  }

  // Always restore, even if a suite hung or threw.
  writeFileSync(path, original);
}

console.log("\n");
console.log(formatMutationReport(results));

const { score } = summarizeMutants(results);
// Fails on the SCORE, not on any survivor at all: a handful of equivalent
// mutants is expected and unfixable (see MINIMUM_SCORE), while a drop
// below the threshold means real assertions were lost.
process.exit(score !== null && score < MINIMUM_SCORE ? 1 : 0);
