import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffPayload,
  classifyFile,
  focusOf,
  orderFiles,
  rankCategories,
  clip,
  renderNotes,
  splitDiff,
} from "./diff-ordering.mjs";

/** Build a diff chunk of roughly `size` bytes for `path`. */
function chunk(path, size, { isNew = false } = {}) {
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(isNew ? ["new file mode 100644"] : []),
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
  ].join("\n");
  const body = "+" + "x".repeat(Math.max(1, size - header.length - 2));
  return `${header}\n${body}`;
}

describe("classifyFile", () => {
  test("recognizes generated content", () => {
    assert.equal(classifyFile("pnpm-lock.yaml"), "generated");
    assert.equal(classifyFile("apps/api/src/schema.gql"), "generated");
    assert.equal(classifyFile("apps/api/generated/prisma/client.ts"), "generated");
  });

  test("recognizes tests, including e2e directories", () => {
    assert.equal(classifyFile("apps/web/src/components/x.spec.tsx"), "tests");
    assert.equal(classifyFile("scripts/lib/y.test.mjs"), "tests");
    assert.equal(classifyFile("apps/web/e2e/critical-flow.ts"), "tests");
  });

  test("classifies build and CI tooling as infra, not source", () => {
    // The correction that makes a CI-focused PR resolve correctly: PR #98
    // touched perf-budget.mjs and the review scripts, and reported "source"
    // before these rules existed.
    assert.equal(classifyFile(".github/workflows/ci.yml"), "infra");
    assert.equal(classifyFile("apps/web/Dockerfile"), "infra");
    assert.equal(classifyFile("docker-compose.yml"), "infra");
    assert.equal(classifyFile("apps/web/next.config.ts"), "infra");
    assert.equal(classifyFile("apps/web/scripts/perf-budget.mjs"), "infra");
    assert.equal(classifyFile("scripts/ai-code-review.mjs"), "infra");
  });

  test("everything else is source", () => {
    assert.equal(classifyFile("apps/web/src/lib/api.ts"), "source");
    assert.equal(classifyFile("apps/api/src/products/products.service.ts"), "source");
  });

  test("docs are their own category", () => {
    assert.equal(classifyFile("CLAUDE.md"), "docs");
  });
});

describe("splitDiff", () => {
  test("splits per file and detects new files", () => {
    const diff = [chunk("a/one.ts", 200), chunk("a/two.ts", 200, { isNew: true })].join("\n");
    const files = splitDiff(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0].isNew, false);
    assert.equal(files[1].isNew, true);
  });

  test("returns nothing for an empty diff", () => {
    assert.deepEqual(splitDiff(""), []);
    assert.deepEqual(splitDiff("   \n"), []);
  });
});

describe("focus follows what actually changed", () => {
  test("a test-heavy change leads with tests", () => {
    // The PR #90 shape: 54% tests by volume.
    const files = splitDiff(
      [chunk("src/a.ts", 400), chunk("src/a.spec.ts", 900), chunk("src/b.spec.ts", 900)].join("\n"),
    );
    assert.equal(focusOf(files), "tests");
    assert.equal(orderFiles(files)[0].category, "tests");
  });

  test("an infra-heavy change leads with infra", () => {
    // The PR #87 shape.
    const files = splitDiff(
      [chunk("src/a.ts", 300), chunk(".github/workflows/ci.yml", 1200)].join("\n"),
    );
    assert.equal(focusOf(files), "infra");
  });

  test("a feature change leads with source", () => {
    const files = splitDiff(
      [chunk("src/a.ts", 1500), chunk("src/a.spec.ts", 400)].join("\n"),
    );
    assert.equal(focusOf(files), "source");
  });

  test("a huge lockfile never becomes the focus", () => {
    // Volume must not equal importance: a lockfile can dwarf everything
    // else while being worth nothing to review.
    const files = splitDiff([chunk("src/a.ts", 300), chunk("pnpm-lock.yaml", 50_000)].join("\n"));
    assert.equal(focusOf(files), "source");
    assert.equal(orderFiles(files).at(-1).category, "generated");
  });

  test("docs never lead either", () => {
    const files = splitDiff([chunk("src/a.ts", 300), chunk("CLAUDE.md", 20_000)].join("\n"));
    assert.equal(focusOf(files), "source");
  });
});

describe("orderFiles", () => {
  test("new files come before modified ones within a category", () => {
    const files = splitDiff(
      [chunk("src/modified.ts", 500), chunk("src/added.ts", 500, { isNew: true })].join("\n"),
    );
    assert.equal(orderFiles(files)[0].path, "src/added.ts");
  });

  test("keeps every file -- ordering never drops anything", () => {
    const files = splitDiff(
      [chunk("src/a.ts", 300), chunk("x.spec.ts", 300), chunk("CLAUDE.md", 300)].join("\n"),
    );
    assert.equal(orderFiles(files).length, files.length);
  });
});

describe("rankCategories", () => {
  test("reports measured byte share per category", () => {
    const files = splitDiff([chunk("src/a.ts", 1000), chunk("a.spec.ts", 500)].join("\n"));
    const { bytes } = rankCategories(files);
    assert.ok(bytes.source > bytes.tests);
  });
});

describe("buildDiffPayload", () => {
  test("under the limit: sends everything, truncated=false", () => {
    const diff = [chunk("src/a.ts", 500), chunk("src/b.ts", 500)].join("\n");
    const out = buildDiffPayload(diff, 100_000);
    assert.equal(out.truncated, false);
    assert.deepEqual(out.notes, []);
    assert.ok(out.text.includes("src/a.ts") && out.text.includes("src/b.ts"));
  });

  test("losing real code DOES set truncated", () => {
    const diff = [chunk("src/a.ts", 40_000), chunk("src/b.ts", 40_000)].join("\n");
    const out = buildDiffPayload(diff, 10_000);
    assert.equal(out.truncated, true);
  });

  test("an empty diff is passed through untouched", () => {
    const out = buildDiffPayload("", 1000);
    assert.equal(out.truncated, false);
  });
});

describe("renderNotes", () => {
  test("is empty when nothing was reduced", () => {
    assert.equal(renderNotes([]), "");
  });

  test("tells the model not to claim an omitted file was reviewed", () => {
    const text = renderNotes(["omitted pnpm-lock.yaml (generated, 900 bytes)"]);
    assert.match(text, /Diff reductions/);
    assert.match(text, /not treat an omitted or truncated/);
    assert.match(text, /pnpm-lock\.yaml/);
  });
});

describe("test classification covers this repo's real naming", () => {
  test("recognizes *.e2e-spec.ts (hyphen, not dot)", () => {
    // apps/api names every suite this way; a `\.spec\.` pattern misses it.
    assert.equal(classifyFile("apps/api/test/products.e2e-spec.ts"), "tests");
  });

  test("recognizes files inside a test/ directory", () => {
    // apps/api/test/ holds the whole e2e suite plus helpers, none of which
    // match a filename pattern.
    assert.equal(classifyFile("apps/api/test/helpers/assert-test-database.ts"), "tests");
    assert.equal(classifyFile("apps/web/test/helpers/server.ts"), "tests");
  });

  test("does not mistake ordinary source for a test", () => {
    assert.equal(classifyFile("apps/web/src/lib/api.ts"), "source");
    assert.equal(classifyFile("apps/api/src/products/products.service.ts"), "source");
  });
});

describe("the budget is genuinely enforced", () => {
  test("many files never exceed the limit, and the marker says so", () => {
    const diff = Array.from({ length: 400 }, (_, i) => chunk(`src/f${i}.ts`, 900)).join("\n");
    const out = buildDiffPayload(diff, 20_000);
    assert.ok(out.text.length <= 20_000, `got ${out.text.length}`);
    assert.equal(out.truncated, true);
    assert.match(out.text, /clipped to fit/);
  });

  test("an UNPARSEABLE diff still respects the limit", () => {
    // The earlier test asserted a 50,000-char result was "<= 50,000"
    // against a 1,000 limit, so it could never fail.
    const out = buildDiffPayload("x".repeat(50_000), 1_000);
    assert.ok(out.text.length <= 1_000, `got ${out.text.length}`);
    assert.equal(out.truncated, true);
  });

  test("clip never overshoots, even when the limit is tiny", () => {
    for (const limit of [0, 5, 20, 47, 100]) {
      assert.ok(clip("y".repeat(500), limit).length <= limit, `limit ${limit}`);
    }
  });

  test("notesReserve is taken out of the budget", () => {
    const diff = Array.from({ length: 50 }, (_, i) => chunk(`src/f${i}.ts`, 900)).join("\n");
    const out = buildDiffPayload(diff, 10_000, { notesReserve: 3_000 });
    assert.ok(out.text.length <= 7_000, `got ${out.text.length}`);
  });
});

describe("lockfile omission is never silent", () => {
  test("dropping a lockfile sets truncated even when code remains", () => {
    // Lockfiles carry dependency resolutions and integrity hashes. An
    // earlier version protected only the generated-ONLY case, so a lockfile
    // vanished silently whenever any source file accompanied it.
    const diff = [chunk("src/a.ts", 1_000), chunk("pnpm-lock.yaml", 80_000)].join("\n");
    const out = buildDiffPayload(diff, 10_000);
    assert.equal(out.truncated, true);
    assert.ok(out.notes.some((n) => n.includes("pnpm-lock.yaml")));
    assert.ok(out.text.includes("src/a.ts"));
  });

  test("a lockfile-only change is bounded and blocking", () => {
    const out = buildDiffPayload(chunk("pnpm-lock.yaml", 80_000), 10_000);
    assert.equal(out.truncated, true);
    assert.ok(out.text.length > 0 && out.text.length <= 10_000);
  });

  test("dropping non-lockfile generated content alone does not block", () => {
    const diff = [chunk("src/a.ts", 1_000), chunk("apps/api/src/schema.gql", 80_000)].join("\n");
    const out = buildDiffPayload(diff, 10_000);
    assert.equal(out.truncated, false);
  });
});
