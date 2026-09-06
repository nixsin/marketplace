import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKER, main, plan, stripProbe } from "./knip-selftest.mjs";

// The probe text for one real file, taken from the script rather than retyped
// -- a copy here would drift and start testing something the script no longer
// writes.
const CONSUMER = plan().find((p) => p.file.endsWith("card.tsx"));
const CARD = 'import * as React from "react";\nexport function Card() {}\n';

describe("stripProbe", () => {
  // The destructive half: whatever this returns is recorded as a real source
  // file's "original" and later written back over it. A bug here does not fail
  // a check, it deletes work.

  test("a file with no probe is returned unchanged", () => {
    assert.equal(stripProbe(CARD, CONSUMER.probe), CARD);
  });

  test("an exact leftover probe is removed", () => {
    assert.equal(stripProbe(CARD + CONSUMER.probe, CONSUMER.probe), CARD);
  });

  test("REFUSES when content follows the probe", () => {
    // The regression that matters most. "Drop everything from the marker
    // onward" silently truncated work a developer appended after a stranded
    // probe. Throwing loses nothing and says what to do.
    assert.throws(
      () => stripProbe(`${CARD}${CONSUMER.probe}export const mine = 1;\n`, CONSUMER.probe),
      /by hand/,
    );
  });

  test("REFUSES a probe that has been edited", () => {
    const edited = CONSUMER.probe.replace("void", "/* void */");
    assert.throws(() => stripProbe(CARD + edited, CONSUMER.probe), /by hand/);
  });

  test("never returns empty for a file that had content", () => {
    // The original bug: the consumer probe was PREPENDED, so the marker sat at
    // offset 0, recovery returned "", and the restore blanked a component.
    // Asserted as a property over several shapes rather than against the one
    // string that broke.
    for (const text of [
      CARD + CONSUMER.probe,
      CARD,
      `${CARD}\n`,
    ]) {
      const recovered = stripProbe(text, CONSUMER.probe);
      assert.notEqual(recovered, "", `erased: ${JSON.stringify(text)}`);
      assert.ok(recovered.includes("export function Card()"), "lost real content");
    }
  });
});

describe("probe placement", () => {
  test("every probe is appended, never prepended", () => {
    // The premise stripProbe rests on. A probe placed before real content puts
    // the marker at offset 0 again; `endsWith` would then never match and
    // every run would throw -- loud, but only once someone is interrupted.
    // Checked against the real planned text, not the source's shape.
    for (const { file, probe } of plan()) {
      assert.ok(probe.startsWith("\n" + MARKER), `${file}'s probe must open with the marker`);
      assert.ok(
        !probe.trimStart().startsWith("import * as"),
        `${file}'s probe must not carry file content`,
      );
    }
  });

  test("the script appends the probe to the original, in that order", () => {
    const source = readFileSync(new URL("./knip-selftest.mjs", import.meta.url), "utf8");
    assert.match(
      source,
      /write\(file,\s*originals\.get\(file\)\s*\+\s*probe\)/,
      "probes must be written as original + probe; the reverse erases files",
    );
  });
});

describe("failure reporting", () => {
  test("an unrestored file fails the run, ahead of any verdict about knip", () => {
    // Read from the source rather than executed: forcing a restore failure
    // needs a real filesystem fault mid-run, and the property worth pinning is
    // the ORDERING -- the unrestored check must come before the findings are
    // judged, or a run that left planted code in the tree could still print
    // "passed". That is this script's own version of the silent failure it
    // exists to catch one level down.
    const source = readFileSync(new URL("./knip-selftest.mjs", import.meta.url), "utf8");

    const unrestoredAt = source.indexOf("if (unrestored.length > 0)");
    const failureAt = source.indexOf("if (failure)");
    const missedAt = source.indexOf("if (missed.length > 0)");
    const passAt = source.indexOf("knip self-test passed");

    assert.ok(unrestoredAt > 0, "the unrestored-files check is gone");
    assert.ok(
      unrestoredAt < failureAt && unrestoredAt < missedAt && unrestoredAt < passAt,
      "cleanup failure must be reported before any verdict, including success",
    );

    // And every path that gives up on a file must record it, or the check
    // above has nothing to fire on.
    const restoreBody = source.slice(
      source.indexOf("const restore = () =>"),
      source.indexOf("const write = (file, text)"),
    );
    const gaveUp = (restoreBody.match(/continue;|catch \(error\)/g) ?? []).length;
    const recorded = (restoreBody.match(/unrestored\.push\(/g) ?? []).length;
    assert.equal(
      recorded,
      gaveUp,
      "every branch that leaves a file unrestored must push to `unrestored`",
    );
  });

  test("writes go through the atomic helper, never writeFileSync directly", () => {
    // writeFileSync truncates first, so an interrupted write leaves a file
    // that is neither the original nor the probe -- which restore refuses to
    // touch and stripProbe refuses to clean, i.e. a damaged file with no way
    // back. Only writeAtomic may touch a tracked source file.
    const source = readFileSync(new URL("./knip-selftest.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("function main("));
    assert.ok(
      !/writeFileSync\(/.test(body),
      "main() must write through writeAtomic, not writeFileSync",
    );
  });
});

describe("main", () => {
  test("refuses to touch a working tree outside CI", () => {
    // The control that makes every data-loss path above unreachable in normal
    // use. Returns 0 rather than failing: not running is not an error, and a
    // developer's push must not break because they are not CI.
    const before = readFileSync(new URL("../apps/web/src/lib/utils.ts", import.meta.url), "utf8");
    assert.equal(main({ force: false, env: {} }), 0);
    const after = readFileSync(new URL("../apps/web/src/lib/utils.ts", import.meta.url), "utf8");
    assert.equal(after, before, "it must not have written anything");
  });
});
