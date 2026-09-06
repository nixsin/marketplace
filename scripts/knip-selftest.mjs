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
 *      hand. The check would not have caught the thing it was built for.
 *   4. `apps/web`'s entry glob covered the whole of `src/app/**`.
 *
 * A manual "add a dead export and look" step was documented after (1) and (2),
 * and did not prevent (3) and (4) — a procedure only runs when someone
 * remembers it. So this asserts the property instead.
 *
 * WHY IT APPENDS TO REAL FILES rather than creating probe files: a file
 * nothing imports is an UNUSED FILE, which is a different finding that
 * `--include exports,types` deliberately filters out. A probe in a new file is
 * therefore never reported, and a self-test built that way fails for a reason
 * unrelated to the thing it is checking. Found by writing it that way first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(import.meta.dirname, "..");

/**
 * One probe per workspace knip can actually check, each appended to a file
 * that is PROJECT code rather than an entry point — an entry's exports are
 * legitimately public, so a probe there would prove nothing.
 *
 * `packages/config` is deliberately absent. Every file in its `src/` is named
 * in the package's `exports` map, so all of them are entry points and knip
 * cannot report unused exports there at all. That is correct rather than a
 * gap: a published package's contract IS its exports map. It does mean an
 * unused export added to that package is not caught here.
 */
const PROBES = [
  { workspace: "root scripts", file: "scripts/lib/diff-ordering.mjs", symbol: "KNIP_PROBE_SCRIPTS" },
  { workspace: "apps/api", file: "apps/api/src/graphql-cache.ts", symbol: "KNIP_PROBE_API" },
  { workspace: "apps/web", file: "apps/web/src/lib/sitemap-xml.ts", symbol: "KNIP_PROBE_WEB" },
];

/**
 * The other direction: an export that MUST NOT be reported.
 *
 * `components/ui/**` is shadcn-vendored and listed as `entry` so its own
 * exports are not reported. The question that leaves open is whether an
 * ordinary helper imported ONLY from there still counts as used — if it did
 * not, the required check would fail on a false positive.
 *
 * `entry` is the right mechanism for that (an entry is analysed, its imports
 * followed, only its exports exempted) where `ignore` would be a bet on knip
 * treating excluded files' imports as uses anyway. Measured: `ignore` happens
 * to behave correctly here too, so this is about not depending on it.
 *
 * A false-positive probe rather than a false-negative one, because a check
 * that blocks merges on work that is genuinely used is the failure that gets
 * the check deleted.
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
const probeSource = (symbol) => `
// Temporary, written by scripts/knip-selftest.mjs. Safe to delete.
export function ${symbol}() {
  return 1;
}
const ${symbol}_LOCAL = ${symbol}();
export function ${symbol}_USER() {
  return ${symbol}_LOCAL;
}
`;


const MARKER = "// Temporary, written by scripts/knip-selftest.mjs. Safe to delete.";

const TOUCHED = [
  ...PROBES.map((p) => p.file),
  NEGATIVE_PROBE.definition,
  NEGATIVE_PROBE.consumer,
];

/**
 * Recover from a run killed before its `finally` could run — a signal or a
 * SIGKILL leaves probes in the tree, and a later run that read one as "the
 * original" would bake it in permanently.
 *
 * SAFE ONLY BECAUSE EVERY PROBE APPENDS. An earlier version PREPENDED the
 * negative probe's import, putting the marker at offset 0 — so this function
 * returned the empty string, that was recorded as the file's original, and the
 * restore blanked a real source file. Reproduced before fixing.
 *
 * Appending everywhere is what makes "from the marker onward" unambiguous, and
 * it is available because `import` declarations are hoisted: an import at the
 * end of a module is valid and still counts as a use. Verified against knip
 * rather than assumed. Keep every probe append-only.
 */
export function withoutLeftoverProbe(text) {
  const at = text.indexOf(MARKER);
  return at === -1 ? text : text.slice(0, at).replace(/\n+$/, "\n");
}

/**
 * Guarded so this file can be imported for its helpers without running the
 * check: `withoutLeftoverProbe` is the destructive half, so it needs tests,
 * and an import that rewrote four source files as a side effect would be a
 * worse cure than the disease.
 */
function main() {
  const originals = new Map();
  for (const file of TOUCHED) {
    originals.set(file, withoutLeftoverProbe(readFileSync(join(REPO, file), "utf8")));
  }

  /** What this script expects each file to contain while knip runs. */
  const planted = new Map();

  /**
   * Restores only files still holding exactly what was planted.
   *
   * knip takes seconds, and an editor saving one of these files in that window
   * would otherwise have its work silently overwritten by the snapshot. A file
   * that changed underneath is left alone and reported instead — noisy, but the
   * alternative is destroying someone's edit to tidy up after a lint.
   */
  const restore = () => {
    for (const [file, text] of originals) {
      const full = join(REPO, file);
      if (readFileSync(full, "utf8") !== planted.get(file)) {
        console.error(
          `knip-selftest: ${file} changed while the check was running; leaving ` +
            `it as it is. Remove the block marked "${MARKER}" by hand.`,
        );
        continue;
      }
      writeFileSync(full, text);
    }
  };

  const write = (file, text) => {
    planted.set(file, text);
    writeFileSync(join(REPO, file), text);
  };

  let output = "";
  try {
    for (const { file, symbol } of PROBES) {
      write(file, originals.get(file) + probeSource(symbol));
    }

    // The negative probe: exported from ordinary project code, imported only
    // from an exempt vendored file. APPENDED, like every other probe -- see
    // withoutLeftoverProbe for why prepending was destructive.
    const { definition, consumer, symbol } = NEGATIVE_PROBE;
    write(
      definition,
      `${originals.get(definition)}\n${MARKER}\nexport function ${symbol}(v) {\n  return v;\n}\n`,
    );
    write(
      consumer,
      `${originals.get(consumer)}\n${MARKER}\nimport { ${symbol} } from "@/lib/utils";\nvoid ${symbol};\n`,
    );

    try {
      execFileSync("pnpm", ["knip:check"], {
        cwd: REPO,
        encoding: "utf8",
        // Explicit, because the default leaves stderr inherited — the findings
        // then print to the terminal and arrive here as null, which reads as
        // "nothing was reported" and fails every probe for the wrong reason.
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Exit 0 means knip found nothing -- impossible with probes planted, so
      // the config is blind. Left as empty output; every probe reports missing.
      output = "";
    } catch (error) {
      // ONLY status 1, which is knip's "issues found". Any other termination is
      // an operational failure, not a result: a crash or a signal can still
      // print diagnostics naming the probe files, and treating that text as
      // findings would report a passing self-test for a run that never
      // completed -- the exact false-green this script exists to prevent.
      if (error.signal || error.status !== 1) {
        console.error(
          `knip-selftest: \`pnpm knip:check\` terminated unexpectedly ` +
            `(status ${error.status ?? "none"}, signal ${error.signal ?? "none"}). ` +
            `This is not a finding; the check did not run to completion.\n`,
        );
        console.error(`${error.stdout ?? ""}${error.stderr ?? ""}`);
        process.exit(1);
      }
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
  } finally {
    restore();
  }

  // WORD BOUNDARY, not `includes`. Each probe declares `SYMBOL` (used in its own
  // file) and `SYMBOL_USER` (not used). With `ignoreExportsUsedInFile: true` only
  // the second is reported — and `"KNIP_PROBE_API_USER".includes("KNIP_PROBE_API")`
  // is true, so a substring test passed while the setting that hides mistake (3)
  // was switched back on. The `_` is a word character, so `\bSYMBOL\b` does not
  // match inside `SYMBOL_USER`, which is exactly the distinction needed.
  const missed = PROBES.filter(
    ({ symbol }) => !new RegExp(`\\b${symbol}\\b`).test(output),
  );

  // The false-positive direction. Reported here means an export used only by an
  // exempt file reads as unused, which would fail the required check on code
  // that is genuinely used.
  if (new RegExp(`\\b${NEGATIVE_PROBE.symbol}\\b`).test(output)) {
    console.error(
      `knip self-test FAILED — ${NEGATIVE_PROBE.symbol} was reported as unused, ` +
        `but ${NEGATIVE_PROBE.consumer} imports it.\n\n` +
        `Exempt files must be listed as \`entry\` in knip.json, not \`ignore\`: ` +
        `an entry is still analysed and its imports still count as uses, where ` +
        `an ignored file's may not. A required check that fails on used code is ` +
        `the failure that gets the check deleted.\n`,
    );
    process.exit(1);
  }

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
    process.exit(1);
  }

  console.log(`knip self-test passed — ${PROBES.length} workspaces covered.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
