import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MUTATION_TARGETS,
  OPERATORS,
  MINIMUM_SCORE,
  classifyMutant,
  summarizeMutants,
  formatMutationReport,
} from "./mutation-testing.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");

describe("MUTATION_TARGETS", () => {
  test("every target file exists", () => {
    // A renamed file would otherwise make the run silently cover less.
    for (const t of MUTATION_TARGETS) {
      assert.ok(existsSync(join(REPO, t.file)), `missing: ${t.file}`);
    }
  });

  test("every target says why it earns the runtime", () => {
    // The list is explicit rather than a glob precisely so each entry is
    // a decision; an entry with no reason is a decision nobody made.
    for (const t of MUTATION_TARGETS) {
      assert.ok(t.why && t.why.length > 20, `thin justification: ${t.file}`);
    }
  });
});

describe("classifyMutant", () => {
  test("a passing suite means the mutant SURVIVED", () => {
    // The whole point: the code changed and no test noticed.
    assert.equal(classifyMutant({ exitCode: 0 }), "survived");
  });

  test("a failing suite means it was killed", () => {
    assert.equal(classifyMutant({ exitCode: 1 }), "killed");
  });

  test("a broken build is invalid, not a kill", () => {
    // A mutant that stops the code compiling proves nothing about
    // assertion quality. Counting it as a kill would flatter the score.
    for (const stderr of [
      "SyntaxError: Unexpected token",
      "Cannot find module './x'",
      "Transform failed with 1 error",
    ]) {
      assert.equal(classifyMutant({ exitCode: 1, stderr }), "invalid");
    }
  });
});

describe("summarizeMutants", () => {
  test("invalid mutants are excluded from the score, not counted as kills", () => {
    const s = summarizeMutants([
      { status: "killed" },
      { status: "survived" },
      { status: "invalid" },
    ]);
    assert.deepEqual(s, { killed: 1, survived: 1, invalid: 1, score: 50 });
  });

  test("no scoreable mutants yields null rather than a misleading 100", () => {
    assert.equal(summarizeMutants([{ status: "invalid" }]).score, null);
    assert.equal(summarizeMutants([]).score, null);
  });
});

describe("the threshold", () => {
  test("is below 100, because equivalent mutants exist", () => {
    // site-url.ts has defence-in-depth branches that Node's URL parser
    // makes unreachable, so no test can kill those mutants. Demanding
    // 100% would mean testing unreachable code -- and a tool that demands
    // the impossible gets switched off.
    assert.ok(MINIMUM_SCORE < 100);
    assert.ok(MINIMUM_SCORE >= 80, "too low to catch a real regression");
  });
});

describe("formatMutationReport", () => {
  const passing = [
    ...Array.from({ length: 9 }, () => ({ status: "killed" })),
    { status: "survived", file: "a.ts", line: 1, operator: "weaken-and" },
  ];

  test("the icon tracks the threshold, not the survivor count", () => {
    // 90% with one survivor is a PASS. Showing ❌ beside a zero exit code
    // would teach people to ignore the icon.
    assert.match(formatMutationReport(passing), /^## ✅/);
  });

  test("fails visibly below the threshold", () => {
    const failing = [
      { status: "killed" },
      { status: "survived", file: "a.ts", line: 1, operator: "weaken-and" },
    ];
    assert.match(formatMutationReport(failing), /^## ❌/);
    assert.match(formatMutationReport(failing), /Below the \d+% threshold/);
  });

  test("lists survivors, since they are the only actionable part", () => {
    assert.match(formatMutationReport(passing), /\| `a\.ts` \| 1 \| weaken-and \|/);
  });
});

describe("OPERATORS", () => {
  test("each operator actually rewrites the code it claims to", () => {
    // An operator whose find/replace never matches would silently reduce
    // coverage while the score stayed high.
    const samples = {
      "negate-condition": "if (!x) return;",
      "weaken-and": "a && b",
      "strengthen-or": "a || b",
      "off-by-one-gt": "a > b",
      "off-by-one-lt": "a < b",
      "always-true": "re.test(x)",
    };
    for (const op of OPERATORS) {
      const sample = samples[op.name];
      assert.ok(sample, `no sample for ${op.name}`);
      op.find.lastIndex = 0;
      assert.notEqual(sample.replace(op.find, op.replace), sample, op.name);
    }
  });
});
