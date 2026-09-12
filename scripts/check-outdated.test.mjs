import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
// fileURLToPath, not .pathname: the latter leaves %20 in a path containing
// spaces and produces an unusable drive-letter path on Windows.
const CLI = fileURLToPath(new URL("./check-outdated.mjs", import.meta.url));
const ALLOWLIST = "eslint  # inline reason\ntypescript\n";

/** Runs the CLI, returning its status and combined output rather than throwing. */
function run(outdatedJson, { allowlist = ALLOWLIST, args, pnpmStatus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-outdated-"));
  try {
    const outPath = join(dir, "outdated.json");
    const allowPath = join(dir, "allowlist.txt");
    writeFileSync(outPath, outdatedJson);
    writeFileSync(allowPath, allowlist);
    try {
      const stdout = execFileSync(
        process.execPath,
        args ?? [CLI, outPath, allowPath, pnpmStatus ?? "1"],
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
  const { status, output } = run("{}", { pnpmStatus: "0" });
  assert.equal(status, 0);
  assert.match(output, /No outdated packages/);
});

test("an EMPTY file is the ordinary success case, not a parse error", () => {
  // `pnpm outdated` writes nothing when everything is current, so this path
  // is reached on every green run — a JSON.parse("") would fail there.
  const { status, output } = run("", { pnpmStatus: "0" });
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

test("REFUSES an empty file when pnpm itself failed", () => {
  // The regression this guards, and it was introduced by moving to JS: the
  // shell version died on an empty file, so a masked pnpm failure was loud.
  // Treating empty as success made "pnpm could not run" byte-identical to
  // "nothing is outdated" — the check would pass while checking nothing.
  const { status, output } = run("", { pnpmStatus: "137" });
  assert.equal(status, 2);
  assert.match(output, /exited 137/);
  assert.doesNotMatch(output, /No outdated packages/);
});

test("accepts an empty file when pnpm reported success", () => {
  const { status, output } = run("", { pnpmStatus: "0" });
  assert.equal(status, 0);
  assert.match(output, /No outdated packages/);
});

test("accepts status 1, which pnpm uses to mean 'found some'", () => {
  const { status } = run(
    JSON.stringify({ "lint-staged": { current: "17.4.1", latest: "17.5.0" } }),
    { pnpmStatus: "1" },
  );
  assert.equal(status, 0);
});

test("a missing input file is an input error, not a dependency finding", () => {
  // Distinct from 1: uncaught readFileSync would also exit 1, making a
  // broken checkout indistinguishable from a real major update.
  const dir = mkdtempSync(join(tmpdir(), "check-outdated-"));
  try {
    const allowPath = join(dir, "allowlist.txt");
    writeFileSync(allowPath, ALLOWLIST);
    let status = 0;
    let output = "";
    try {
      execFileSync(process.execPath, [CLI, join(dir, "nope.json"), allowPath, "1"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = error.status;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.equal(status, 2);
    assert.match(output, /could not read its inputs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REFUSES an empty RESULT when pnpm said it found something", () => {
  // status 1 means "found outdated packages", so an empty result contradicts
  // it -- and that combination is also what a failure mid-run looks like.
  //
  // Both spellings, because they are the same claim and an earlier version
  // checked only the raw text, which left "{}" accepted: it parsed, reported
  // "No outdated packages" and exited 0.
  for (const body of ["", "{}"]) {
    const { status, output } = run(body, { pnpmStatus: "1" });
    assert.equal(status, 2, `expected an input error for ${JSON.stringify(body)}`);
    assert.match(output, /reported none/);
    assert.doesNotMatch(output, /No outdated packages/);
  }
});

test("REFUSES a non-empty result when pnpm said nothing was outdated", () => {
  // The reciprocal direction. The invariant is a biconditional -- pnpm exits
  // 1 exactly when it found something -- so status 0 with packages is just
  // as contradictory as status 1 with none, and accepting it would classify
  // a result its own status disowns.
  const { status, output } = run(
    JSON.stringify({ "lint-staged": { current: "17.4.1", latest: "17.5.0" } }),
    { pnpmStatus: "0" },
  );
  assert.equal(status, 2);
  assert.match(output, /exited 0/);
});

test("the pnpm status is REQUIRED, not optional", () => {
  // Optional would be the same hole with extra steps: a caller that forgot
  // it would silently get the unvouched behaviour back.
  const { status, output } = run("{}", { args: [CLI, "a.json", "b.txt"] });
  assert.equal(status, 2);
  assert.match(output, /Usage:/);
});

test("valid JSON of the wrong SHAPE is an input error", () => {
  // `[]` would report "No outdated packages" and pass; `null` would throw
  // out of Object.keys and exit 1, which reads as a dependency finding.
  for (const [body, expected] of [
    ["[]", /an array/],
    ["null", /null/],
    ['"a string"', /string/],
    ["42", /number/],
  ]) {
    const { status, output } = run(body, { pnpmStatus: "1" });
    assert.equal(status, 2, `expected an input error for ${body}`);
    assert.match(output, /expected a package map/);
    assert.match(output, expected);
  }
});

test("malformed JSON is an input error, not a dependency finding", () => {
  const { status, output } = run("{not json", { pnpmStatus: "1" });
  assert.equal(status, 2);
  assert.match(output, /could not parse/);
});
