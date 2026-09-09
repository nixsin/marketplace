import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI itself, spawned for real.
 *
 * lib/check-outdated.test.mjs covers the decision; this covers everything
 * around it that the decision cannot see — reading the files, the empty-file
 * case, argument validation, and above all the EXIT STATUS, which is the
 * only part CI actually consumes. The shell test this replaced did exercise
 * those, and dropping them with it would have left the process boundary
 * uncovered while the logic looked well tested.
 */
const CLI = new URL("./check-outdated.mjs", import.meta.url).pathname;
const ALLOWLIST = "eslint  # inline reason\ntypescript\n";

/** Runs the CLI, returning its status and combined output rather than throwing. */
function run(outdatedJson, { allowlist = ALLOWLIST, args } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-outdated-"));
  try {
    const outPath = join(dir, "outdated.json");
    const allowPath = join(dir, "allowlist.txt");
    writeFileSync(outPath, outdatedJson);
    writeFileSync(allowPath, allowlist);
    try {
      const stdout = execFileSync(
        process.execPath,
        args ?? [CLI, outPath, allowPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, output: stdout };
    } catch (error) {
      return {
        status: error.status,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("exits 0 and says so when nothing is outdated", () => {
  const { status, output } = run("{}");
  assert.equal(status, 0);
  assert.match(output, /No outdated packages/);
});

test("an EMPTY file is the ordinary success case, not a parse error", () => {
  // `pnpm outdated` writes nothing when everything is current, so this path
  // is reached on every green run — a JSON.parse("") would fail there.
  const { status, output } = run("");
  assert.equal(status, 0);
  assert.match(output, /No outdated packages/);
});

test("exits 0 for same-major gaps, and still lists them", () => {
  const { status, output } = run(
    JSON.stringify({ "lint-staged": { current: "17.4.1", latest: "17.5.0" } }),
  );
  assert.equal(status, 0);
  assert.match(output, /Same-major updates/);
  // Not failing must never mean not shown.
  assert.match(output, /lint-staged/);
});

test("exits 1 for an unaccounted MAJOR gap, and names it", () => {
  const { status, output } = run(
    JSON.stringify({ shadcn: { current: "4.17.0", latest: "5.0.0" } }),
  );
  assert.equal(status, 1);
  assert.match(output, /MAJOR updates NOT on the allowlist/);
  assert.match(output, /shadcn/);
});

test("exits 0 when every major gap is allowlisted", () => {
  const { status, output } = run(
    JSON.stringify({ eslint: { current: "9.39.5", latest: "10.10.0" } }),
  );
  assert.equal(status, 0);
  assert.match(output, /nothing actionable right now/);
});

test("exits 2 when its arguments are missing", () => {
  // Distinct from 1: a usage error is not a dependency finding, and CI
  // should not read one as the other.
  const { status, output } = run("{}", { args: [CLI] });
  assert.equal(status, 2);
  assert.match(output, /Usage:/);
});
