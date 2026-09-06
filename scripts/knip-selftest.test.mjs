import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withoutLeftoverProbe } from "./knip-selftest.mjs";

const MARKER = "// Temporary, written by scripts/knip-selftest.mjs. Safe to delete.";

describe("withoutLeftoverProbe", () => {
  // This is the destructive half of the self-test: whatever it returns is
  // recorded as a real source file's "original" and later written back over
  // that file. A bug here does not fail a check, it deletes work.
  test("leaves a file with no probe untouched", () => {
    const clean = "export const a = 1;\n";
    assert.equal(withoutLeftoverProbe(clean), clean);
  });

  test("strips an appended probe back to the original", () => {
    const original = "export const a = 1;\n";
    assert.equal(
      withoutLeftoverProbe(`${original}\n${MARKER}\nexport const probe = 2;\n`),
      original,
    );
  });

  test("NEVER returns empty for a file that had content", () => {
    // The regression that matters. The negative probe's import used to be
    // PREPENDED, putting the marker at offset 0 -- so this returned "", that
    // was recorded as the original, and the restore blanked a real component.
    //
    // Asserted as a property over every probe shape rather than against the
    // one prepended string, because the guarantee wanted is "recovery cannot
    // erase a file", not "that one bug is gone".
    const original = 'import * as React from "react";\nexport function Card() {}\n';
    for (const leftover of [
      `${original}\n${MARKER}\nimport { x } from "@/lib/utils";\n`,
      `${original}${MARKER}\n`,
      `${original}\n${MARKER}`,
    ]) {
      const recovered = withoutLeftoverProbe(leftover);
      assert.notEqual(recovered, "", `erased the file: ${JSON.stringify(leftover)}`);
      assert.ok(
        recovered.includes("export function Card()"),
        `lost real content: ${JSON.stringify(recovered)}`,
      );
    }
  });

  test("a marker at offset 0 still erases everything -- so probes must append", () => {
    // Documents the sharp edge rather than pretending it is gone. Recovery is
    // "everything from the marker onward is ours", which is only correct while
    // every probe appends. The test below enforces that premise.
    assert.equal(withoutLeftoverProbe(`${MARKER}\nanything\n`), "");
  });

  test("every probe in knip-selftest.mjs is appended, never prepended", () => {
    // The premise the recovery logic rests on, checked against the real file.
    // A future probe written as `MARKER + original` would reintroduce the
    // file-erasing bug, and would do it silently -- the self-test would keep
    // passing until a run was interrupted.
    const source = readFileSync(
      new URL("./knip-selftest.mjs", import.meta.url),
      "utf8",
    );
    const writes = [...source.matchAll(/\bwrite\(\s*([A-Za-z]+)\s*,\s*([\s\S]*?)\n\s*\);/g)];
    assert.ok(writes.length >= 2, `expected several write() calls, found ${writes.length}`);

    for (const [, target, value] of writes) {
      assert.ok(
        /^\s*(?:`\$\{originals\.get\(|originals\.get\()/.test(value),
        `write(${target}, ...) does not start from the original — a probe must ` +
          `be appended to it, never placed before it`,
      );
    }
  });
});
