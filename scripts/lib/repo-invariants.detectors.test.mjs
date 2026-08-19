// Fixtures for the detectors in repo-invariants.mjs.
//
// Separate from repo-invariants.test.mjs on purpose. That file asserts the
// *live repo* satisfies each rule; this one asserts the detectors can tell
// the difference at all. A review round on the first version made the case:
// a detector validated only against a currently-clean repo is
// indistinguishable from one that always returns "fine", and two of the
// original checks were exactly that -- a job-level `timeout-minutes` regex
// that also matched step-level keys, and a `contents: write` regex that
// matched the string anywhere at any depth.
//
// Every detector below therefore gets both a passing and a failing fixture.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  badgeJobsMissingWrite,
  escapeRegExp,
  extractFiltersBlock,
  filterEntries,
  findConstructingPaginateJq,
  findFileFlagMisuse,
  hasContentsWritePermission,
  jobsMissingTimeout,
  needsList,
  parseCiJobs,
} from "./repo-invariants.mjs";

describe("parseCiJobs", () => {
  test("returns only blocks that declare runs-on", () => {
    const yaml = `
on: push
jobs:
  real-job:
    name: Real
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  not-a-job:
    description: just a mapping
`;
    assert.deepEqual(Object.keys(parseCiJobs(yaml)), ["real-job"]);
  });
});

describe("timeout detection respects nesting", () => {
  const withJobLevel = `
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo hi
`;
  // The exact false negative a review caught: GitHub Actions allows
  // timeout-minutes on a STEP too, and a naive /^\\s+timeout-minutes:/m
  // accepts it while the job itself keeps the 6-hour default.
  const onlyStepLevel = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        timeout-minutes: 10
`;

  test("accepts a job-level timeout", () => {
    assert.deepEqual(jobsMissingTimeout(parseCiJobs(withJobLevel)), []);
  });

  test("rejects a step-level timeout masquerading as job-level", () => {
    assert.deepEqual(jobsMissingTimeout(parseCiJobs(onlyStepLevel)), ["a"]);
  });
});

describe("permissions.contents detection respects nesting", () => {
  const proper = `
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: scripts/publish-badge.sh x y
`;
  // `contents: write` present, but under `with:` -- not a permission at all.
  const misplaced = `
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@v1
        with:
          contents: write
      - run: scripts/publish-badge.sh x y
`;
  const readOnly = `
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: scripts/publish-badge.sh x y
`;

  test("accepts contents: write nested under job-level permissions", () => {
    assert.equal(hasContentsWritePermission(proper), true);
  });

  test("rejects contents: write nested somewhere else entirely", () => {
    assert.equal(hasContentsWritePermission(misplaced), false);
  });

  test("rejects contents: read", () => {
    assert.equal(hasContentsWritePermission(readOnly), false);
  });

  test("badgeJobsMissingWrite only flags jobs that publish a badge", () => {
    const jobs = { good: proper, bad: misplaced, unrelated: "    runs-on: x\n" };
    assert.deepEqual(badgeJobsMissingWrite(jobs), ["bad"]);
  });
});

describe("needsList", () => {
  test("reads a flow-style list", () => {
    assert.deepEqual(needsList("    needs: [changes, lint]\n"), ["changes", "lint"]);
  });

  test("reads a multi-line bracketed list", () => {
    assert.deepEqual(needsList("    needs:\n      [\n        changes,\n        lint,\n      ]\n"), [
      "changes",
      "lint",
    ]);
  });

  test("reads a block sequence", () => {
    assert.deepEqual(needsList("    needs:\n      - changes\n      - lint\n"), ["changes", "lint"]);
  });

  test("reads a single scalar", () => {
    assert.deepEqual(needsList("    needs: changes\n"), ["changes"]);
  });

  test("does not mistake a needs.*.result comment for a dependency", () => {
    // The bug in the first version: /needs:.*changes/s matched prose in the
    // job's own comments, so the assertion could never fail.
    const body = `
    # Explicit needs.*.result check -- a changes failure must block deploy.
    if: \${{ !contains(needs.*.result, 'failure') }}
    needs: [lint]
`;
    assert.deepEqual(needsList(body), ["lint"]);
  });
});

describe("findFileFlagMisuse", () => {
  test("flags -f key=@path and its variants", () => {
    assert.equal(findFileFlagMisuse("gh api x -f body=@/tmp/a.md").length, 1);
    assert.equal(findFileFlagMisuse("gh api x -f 'body=@/tmp/a.md'").length, 1);
    assert.equal(findFileFlagMisuse("gh api x --raw-field body=@/tmp/a.md").length, 1);
  });

  test("does not flag -F, which genuinely reads the file", () => {
    assert.deepEqual(findFileFlagMisuse("gh api x -F body=@/tmp/a.md"), []);
    assert.deepEqual(findFileFlagMisuse("gh api x --field body=@/tmp/a.md"), []);
  });

  test("does not flag -f with an ordinary value", () => {
    assert.deepEqual(findFileFlagMisuse("gh api x -f body=hello"), []);
  });
});

describe("findConstructingPaginateJq", () => {
  test("flags a filter that builds an array or object", () => {
    assert.equal(findConstructingPaginateJq("gh api x --paginate --jq '[.[] | .id]'").length, 1);
    assert.equal(findConstructingPaginateJq("gh api x --paginate --jq '{a: .b}'").length, 1);
    assert.equal(findConstructingPaginateJq('gh api x --paginate --jq "[.[]]"').length, 1);
    assert.equal(findConstructingPaginateJq("gh api x --paginate --jq='[.[]]'").length, 1);
  });

  test("does NOT flag a stream-of-scalars filter", () => {
    // Three usages of this shape are live and correct. Flagging them would
    // make the check noise, which is how a check earns being ignored.
    assert.deepEqual(findConstructingPaginateJq("gh api x --paginate --jq '.[] | .id'"), []);
    assert.deepEqual(
      findConstructingPaginateJq("gh api x --paginate --jq '.jobs[] | select(.x) | .id'"),
      [],
    );
  });

  test("does not flag --jq without --paginate", () => {
    assert.deepEqual(findConstructingPaginateJq("gh api x --jq '[.[]]'"), []);
  });
});

describe("filterEntries", () => {
  const yaml = `
            web:
              - 'apps/web/**'
              - 'packages/**'
            docker:
              - 'apps/api/**'
              - '!packages/**'
`;

  test("returns active entries", () => {
    assert.deepEqual(filterEntries(yaml, "web"), ["apps/web/**", "packages/**"]);
  });

  test("treats a negated glob as absent, not present", () => {
    // `!packages/**` is an EXCLUSION -- counting it as satisfying the rule
    // would invert the rule's meaning.
    assert.deepEqual(filterEntries(yaml, "docker"), ["apps/api/**"]);
  });

  test("returns null for a key that isn't there", () => {
    assert.equal(filterEntries(yaml, "nope"), null);
  });
});

describe("escapeRegExp", () => {
  test("neutralizes metacharacters so a literal path stays literal", () => {
    // A package directory containing `.` would otherwise let a DIFFERENT
    // package's path satisfy the assertion.
    const escaped = escapeRegExp("my.pkg");
    assert.equal(new RegExp(escaped).test("my.pkg"), true);
    assert.equal(new RegExp(escaped).test("myXpkg"), false);
  });
});

describe("comment awareness and continuations", () => {
  test("a comment documenting the hazard is not flagged", () => {
    // scripts/lib/override-decisions.mjs carries exactly such a comment.
    assert.deepEqual(findConstructingPaginateJq("// gh api x --paginate --jq '[.[]]' is broken"), []);
    assert.deepEqual(findFileFlagMisuse("# never use -f body=@file here"), []);
  });

  test("real code on the same shapes is still flagged", () => {
    assert.equal(findConstructingPaginateJq("gh api x --paginate --jq '[.[]]'").length, 1);
    assert.equal(findFileFlagMisuse("gh api x -f body=@file").length, 1);
  });

  test("a command split across lines with a backslash is still seen", () => {
    const cmd = "gh api x --paginate \\\n  --jq '[.[] | .id]'";
    assert.equal(findConstructingPaginateJq(cmd).length, 1);
  });

  test("gh's -q alias for --jq is covered", () => {
    assert.equal(findConstructingPaginateJq("gh api x --paginate -q '{a: .b}'").length, 1);
    assert.deepEqual(findConstructingPaginateJq("gh api x --paginate -q '.[] | .id'"), []);
  });
});

describe("extractFiltersBlock", () => {
  test("returns only the paths-filter block, not a same-named key elsewhere", () => {
    // `web:` genuinely appears twice in this repo's ci.yml. Without
    // scoping, a key lookup can read an unrelated mapping and report the
    // wrong answer -- and this detector had no fixture of its own.
    const yaml = `
jobs:
  something:
    web:
      - 'decoy/**'
  changes:
    steps:
      - uses: dorny/paths-filter@v4
        with:
          filters: |
            web:
              - 'apps/web/**'
    runs-on: ubuntu-latest
`;
    const block = extractFiltersBlock(yaml);
    assert.ok(block, "should find the filters block");
    assert.deepEqual(filterEntries(block, "web"), ["apps/web/**"]);
    assert.ok(!block.includes("decoy"), "must not reach the unrelated mapping");
  });

  test("returns null when there is no filters block", () => {
    assert.equal(extractFiltersBlock("jobs:\n  a:\n    runs-on: x\n"), null);
  });
});
