#!/usr/bin/env node
/**
 * Proves `pnpm knip:check` can still SEE each workspace it is supposed to.
 *
 * A misconfigured knip exits 0 and is indistinguishable from a clean repo.
 * That is not hypothetical: this config was wrong four times before it could
 * catch anything, every time in the silent direction.
 *
 *   1. `packages/config` declared `src/*.js` as entry — an entry's exports are
 *      never reported, so the whole package read as clean.
 *   2. the root workspace declared `scripts/**` as entry, which covers
 *      `scripts/lib/**` — exactly where the findings live.
 *   3. `ignoreExportsUsedInFile: true` suppressed every export used only
 *      inside its own file, which is most of the eighteen #200 removed by
 *      hand. The check would not have caught the class it was built for.
 *   4. `apps/web`'s entry glob covered the whole of `src/app/**`.
 *
 * A manual "add a dead export and look" step was documented after (1) and (2),
 * and did not prevent (3) and (4) — a procedure only runs when someone
 * remembers it. So this asserts the property instead.
 *
 * ── Why it refuses to run on a working tree ──────────────────────────────
 *
 * It proves the property by TEMPORARILY REWRITING REAL SOURCE FILES, which is
 * inherently hazardous, and three rounds of review each found a different way
 * for that to destroy work: a prepended probe made recovery blank a file, a
 * concurrent editor save could be overwritten by the restore, and content
 * appended after a probe could be truncated by the next run's recovery.
 *
 * Each was fixed, and patching them one at a time was the wrong shape. The
 * hazard is the working tree itself, so the script now requires CI — where the
 * checkout is disposable and nobody is editing — or an explicit `--force` for
 * someone deliberately changing knip.json locally. The safety below is kept as
 * defence in depth for that `--force` path, not as the primary control.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(import.meta.dirname, "..");

export const MARKER =
  "// Temporary, written by scripts/knip-selftest.mjs. Safe to delete.";

/**
 * One probe per workspace knip can actually check, each appended to a file
 * that is PROJECT code rather than an entry point — an entry's exports are
 * legitimately public, so a probe there would prove nothing.
 *
 * `packages/config` is deliberately absent. Every file in its `src/` is named
 * in the package's `exports` map, so all of them are entry points and knip
 * cannot report unused exports there at all. That is correct rather than a
 * gap: a published package's contract IS its exports map. It does mean an
 * unused export added to that package is caught by nothing.
 */
const PROBES = [
  { workspace: "root scripts", file: "scripts/lib/diff-ordering.mjs", symbol: "KNIP_PROBE_SCRIPTS" },
  { workspace: "apps/api", file: "apps/api/src/graphql-cache.ts", symbol: "KNIP_PROBE_API" },
  { workspace: "apps/web", file: "apps/web/src/lib/sitemap-xml.ts", symbol: "KNIP_PROBE_WEB" },
];

/**
 * The other direction: an export that MUST NOT be reported.
 *
 * `components/ui/**` is shadcn-vendored and listed as `entry`, so its own
 * exports are not reported. The open question is whether an ordinary helper
 * imported ONLY from there still counts as used — if it did not, the required
 * check would fail on a false positive, and a check that blocks merges on
 * genuinely-used code is the one that gets deleted.
 *
 * `entry` is the right mechanism (an entry is analysed and its imports
 * followed; only its exports are exempt) where `ignore` would be a bet on knip
 * counting excluded files' imports anyway. Measured: `ignore` does behave
 * correctly here today, so this pins the requirement rather than fixing a live
 * bug — a review asserted the opposite and it did not reproduce.
 */
const NEGATIVE_PROBE = {
  definition: "apps/web/src/lib/utils.ts",
  consumer: "apps/web/src/components/ui/card.tsx",
  symbol: "KNIP_PROBE_VENDORED_ONLY",
};

/**
 * Used inside its own file on purpose. That is the shape `ignoreExportsUsedInFile`
 * hides — mistake (3) above — so a probe that is merely declared would still
 * pass with that setting wrong.
 */
const unusedExportProbe = (symbol) => `
${MARKER}
export function ${symbol}() {
  return 1;
}
const ${symbol}_LOCAL = ${symbol}();
export function ${symbol}_USER() {
  return ${symbol}_LOCAL;
}
`;

const definitionProbe = (symbol) => `
${MARKER}
export function ${symbol}(v) {
  return v;
}
`;

/**
 * APPENDED, like every other probe, and that is load-bearing rather than
 * stylistic: `import` declarations are hoisted, so an import at the end of a
 * module is valid and still counts as a use — verified against knip, not
 * assumed. An earlier version prepended this one, which put MARKER at offset 0
 * and made recovery return the empty string.
 */
const consumerProbe = (symbol) => `
${MARKER}
import { ${symbol} } from "@/lib/utils";
void ${symbol};
`;

/** Every file this script writes to, with the exact text it appends. */
function plan() {
  const items = PROBES.map(({ workspace, file, symbol }) => ({
    workspace,
    file,
    symbol,
    probe: unusedExportProbe(symbol),
  }));
  const { definition, consumer, symbol } = NEGATIVE_PROBE;
  items.push({ file: definition, symbol, probe: definitionProbe(symbol) });
  items.push({ file: consumer, symbol, probe: consumerProbe(symbol) });
  return items;
}

/**
 * Removes a leftover probe, and REFUSES rather than guessing.
 *
 * Recovery exists for a run killed before its cleanup — `finally` does not run
 * on SIGKILL. The earlier rule was "drop everything from the marker onward",
 * which is wrong the moment anything follows the probe: a developer who
 * appended work after a stranded probe would have it silently truncated by the
 * next run.
 *
 * So the only text removed is an EXACT match for what this script writes, at
 * the end of the file. Anything else — a modified probe, content after it —
 * throws, because the alternative is deleting work to tidy up after a lint.
 */
export function stripProbe(text, probe) {
  if (!text.includes(MARKER)) return text;
  if (text.endsWith(probe)) return text.slice(0, -probe.length);
  throw new Error(
    `a leftover knip-selftest probe is present but does not match what this ` +
      `script writes, so it cannot be removed automatically without risking ` +
      `real content. Remove the block marked "${MARKER}" by hand.`,
  );
}

function main({ force = false, env = process.env } = {}) {
  if (!env.CI && !force) {
    console.error(
      "knip-selftest rewrites real source files while it runs, so it is CI-only.\n" +
        "CI checkouts are disposable; a working tree is not, and every data-loss\n" +
        "path this script has had came from editing one.\n\n" +
        "Changing knip.json locally? Commit first, then: pnpm knip:selftest -- --force\n",
    );
    return 0;
  }

  const items = plan();
  const originals = new Map();
  for (const { file, probe } of items) {
    originals.set(file, stripProbe(readFileSync(join(REPO, file), "utf8"), probe));
  }

  /** What this script expects each file to hold while knip runs. */
  const planted = new Map();

  /**
   * Restores only files still holding exactly what was planted, one at a time.
   *
   * Per-file, because a single failure — an editor renaming a file mid-run —
   * must not abort the loop and strand probes in every file after it. And
   * exact-match, because overwriting a concurrent save to tidy up after a lint
   * is a worse outcome than leaving a probe behind and saying so.
   */
  const restore = () => {
    for (const [file, text] of originals) {
      const full = join(REPO, file);
      try {
        if (readFileSync(full, "utf8") !== planted.get(file)) {
          console.error(
            `knip-selftest: ${file} changed while the check was running; ` +
              `leaving it alone. Remove the "${MARKER}" block by hand.`,
          );
          continue;
        }
        writeFileSync(full, text);
      } catch (error) {
        console.error(`knip-selftest: could not restore ${file}: ${error.message}`);
      }
    }
  };

  const write = (file, text) => {
    planted.set(file, text);
    writeFileSync(join(REPO, file), text);
  };

  let output = "";
  let failure = null;

  try {
    for (const { file, probe } of items) {
      write(file, originals.get(file) + probe);
    }

    try {
      execFileSync("pnpm", ["knip:check"], {
        cwd: REPO,
        encoding: "utf8",
        // Explicit, because the default leaves stderr inherited — the findings
        // then print to the terminal and arrive here as null, which reads as
        // "nothing was reported" and fails every probe for the wrong reason.
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Exit 0 means knip found nothing, which is impossible with probes
      // planted: the config is blind. Empty output, so every probe reports.
      output = "";
    } catch (error) {
      // ONLY status 1, knip's "issues found". Any other termination is an
      // operational failure rather than a result — a crash or a signal can
      // still print diagnostics naming the probe files, and reading that as
      // findings would report a passing self-test for a run that never
      // completed, the exact false-green this script exists to prevent.
      //
      // Recorded rather than exited on, because `process.exit()` here would
      // skip the `finally` below and strand every probe in the tree.
      if (error.signal || error.status !== 1) {
        failure =
          `\`pnpm knip:check\` terminated unexpectedly (status ` +
          `${error.status ?? "none"}, signal ${error.signal ?? "none"}). This is ` +
          `not a finding; the check did not run to completion.\n\n` +
          `${error.stdout ?? ""}${error.stderr ?? ""}`;
      } else {
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }
    }
  } finally {
    restore();
  }

  if (failure) {
    console.error(`knip self-test FAILED — ${failure}`);
    return 1;
  }

  // The false-positive direction: reported here means an export used only by
  // an exempt file reads as unused.
  if (new RegExp(`\\b${NEGATIVE_PROBE.symbol}\\b`).test(output)) {
    console.error(
      `knip self-test FAILED — ${NEGATIVE_PROBE.symbol} was reported as unused, ` +
        `but ${NEGATIVE_PROBE.consumer} imports it.\n\n` +
        `Exempt files must be listed as \`entry\` in knip.json, not \`ignore\`: ` +
        `an entry is still analysed and its imports still count as uses.\n`,
    );
    return 1;
  }

  // WORD BOUNDARY, not `includes`. Each probe declares `SYMBOL` (used in its
  // own file) and `SYMBOL_USER` (not), so with `ignoreExportsUsedInFile`
  // wrongly on, only the second is reported — and
  // `"SYMBOL_USER".includes("SYMBOL")` is true, so a substring test passed
  // while mistake (3) was switched back on. `_` is a word character, so
  // `\bSYMBOL\b` does not match inside `SYMBOL_USER`.
  const missed = PROBES.filter(
    ({ symbol }) => !new RegExp(`\\b${symbol}\\b`).test(output),
  );

  if (missed.length > 0) {
    console.error("knip self-test FAILED — the config cannot see these areas:\n");
    for (const { workspace, file } of missed) {
      console.error(`  ${workspace.padEnd(16)} ${file}`);
    }
    console.error(
      "\nAn unused export planted there was not reported, so real ones are " +
        "invisible to `pnpm knip:check` too. The usual causes are an `entry` " +
        "pattern in knip.json broad enough to cover that workspace's own " +
        "project files, or `ignoreExportsUsedInFile` being true.\n",
    );
    return 1;
  }

  console.log(`knip self-test passed — ${PROBES.length} workspaces covered.`);
  return 0;
}

/**
 * Guarded so this file can be imported for its helpers without running the
 * check — `stripProbe` is the destructive half and needs tests, and an import
 * that rewrote five source files as a side effect would be a worse cure than
 * the disease.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main({ force: process.argv.includes("--force") });
}

export { main, plan };
