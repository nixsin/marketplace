import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutdated, majorOf, parseAllowlist } from "./check-outdated.mjs";

const ALLOWLIST = `
# a comment, ignored

eslint
@eslint/js  # inline reason: must be stripped, not read as part of the name
   typescript
`;

test("allowlist parsing drops comments, blanks and inline reasons", () => {
  // The inline reason is the whole point of allowing one: a bare package
  // name cannot be reviewed without cross-referencing CLAUDE.md, and the two
  // drift. If it stops being stripped the entry silently stops matching.
  assert.deepEqual(parseAllowlist(ALLOWLIST), [
    "eslint",
    "@eslint/js",
    "typescript",
  ]);
});

test("majorOf reads well-formed versions, prefixes included", () => {
  assert.equal(majorOf("1.62.1"), 1);
  assert.equal(majorOf("8.0.0-rc.13"), 8);
  assert.equal(majorOf("0.123.0"), 0);
  assert.equal(majorOf("v1.2.3"), 1);
  assert.equal(majorOf(" 1.2.3 "), 1);
});

test("majorOf refuses anything that is not a version", () => {
  // Every one of these was accepted by a hand-rolled parser at some point,
  // and each was accepted in the dangerous direction -- as a real major,
  // which lets two malformed values compare EQUAL and pass.
  for (const bad of [
    "not-a-version",
    "build1.alpha",
    "release1-beta",
    "1.2.3-foo..bar",
    "^ v =1.2.3",
    "^^1.2.3",
    ">=1.2.3", // a range is not a version
    "=1.2.3", // loose-mode only; must not be accepted
    "01.2.3", // loose-mode only: leading zero
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(majorOf(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("a same-major gap is not actionable", () => {
  // The rule. Dependabot's weekly grouped PR already carries every minor and
  // patch, so failing here reports nothing the PR queue does not, while
  // going red on essentially every publish.
  const { sameMajor, actionable } = classifyOutdated(
    {
      "@playwright/test": { current: "1.62.1", latest: "1.63.0" },
      "lint-staged": { current: "17.4.1", latest: "17.5.0" },
    },
    ALLOWLIST,
  );
  assert.deepEqual(sameMajor, ["@playwright/test", "lint-staged"]);
  assert.deepEqual(actionable, []);
});

test("a 0.x minor counts as same-major, deliberately", () => {
  // By strict semver 0.x's minor slot is where breaking changes go, so this
  // is a judgment call rather than an oversight: Dependabot groups 0.x
  // minors into the same weekly PR regardless, so failing would add a red
  // without changing how the bump is actually reviewed.
  const { sameMajor } = classifyOutdated(
    { "@anthropic-ai/sdk": { current: "0.123.0", latest: "0.124.0" } },
    ALLOWLIST,
  );
  assert.deepEqual(sameMajor, ["@anthropic-ai/sdk"]);
});

test("a major gap is actionable", () => {
  const { actionable } = classifyOutdated(
    { shadcn: { current: "4.17.0", latest: "5.0.0" } },
    ALLOWLIST,
  );
  assert.deepEqual(actionable, ["shadcn"]);
});

test("a prerelease one major ahead is still a major gap", () => {
  // prisma's own `latest` is an RC a whole major ahead; the tail must not
  // confuse the comparison into reading it as same-major.
  const { actionable } = classifyOutdated(
    { someprisma: { current: "7.10.0", latest: "8.0.0-rc.13" } },
    ALLOWLIST,
  );
  assert.deepEqual(actionable, ["someprisma"]);
});

test("malformed versions sharing an embedded digit are NOT same-major", () => {
  // The exact false negative that killed the hand-rolled parser: both
  // reduced to 1 and compared equal.
  const { actionable, sameMajor } = classifyOutdated(
    { weird: { current: "build1.alpha", latest: "release1-beta" } },
    ALLOWLIST,
  );
  assert.deepEqual(actionable, ["weird"]);
  assert.deepEqual(sameMajor, []);
});

test("allowlisted packages are excluded whatever their gap", () => {
  const { allowlisted, actionable, sameMajor } = classifyOutdated(
    {
      eslint: { current: "9.39.5", latest: "10.10.0" },
      typescript: { current: "5.9.3", latest: "7.0.2" },
    },
    ALLOWLIST,
  );
  assert.deepEqual(allowlisted, ["eslint", "typescript"]);
  assert.deepEqual(actionable, []);
  assert.deepEqual(sameMajor, []);
});

test("an empty outdated set is not actionable", () => {
  const { actionable, sameMajor, allowlisted } = classifyOutdated({}, ALLOWLIST);
  assert.deepEqual([...actionable, ...sameMajor, ...allowlisted], []);
});
