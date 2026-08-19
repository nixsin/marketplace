// Asserts the LIVE repo satisfies invariants that CLAUDE.md previously
// stated only as prose. Each is a rule this repo has already been bitten
// by, or one that silently rots if nobody remembers it.
//
// The detection logic lives in repo-invariants.mjs and has its own fixtures
// (repo-invariants.detectors.test.mjs) proving each detector can tell a
// violation from a clean file. That split exists because a detector
// validated only against a currently-clean repo is indistinguishable from
// one that always returns "fine" -- a review round found two checks here in
// exactly that state, and the fixtures then caught a third bug in the
// detectors themselves.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  badgeJobsMissingWrite,
  escapeRegExp,
  extractFiltersBlock,
  filterEntries,
  findConstructingPaginateJq,
  findFileFlagMisuse,
  jobsMissingTimeout,
  needsList,
  parseCiJobs,
} from "./repo-invariants.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");
const CI_YML = read(".github/workflows/ci.yml");
const JOBS = parseCiJobs(CI_YML);
const APP_DOCKERFILES = ["apps/api/Dockerfile", "apps/web/Dockerfile"];

// Every workflow plus every shell-bearing script, found RECURSIVELY. A
// review round caught that a non-recursive readdir skipped scripts/lib
// entirely -- the directory holding most of this repo's script logic, and
// the one these very files live in -- while the comment claimed otherwise.
function walk(relDir, out = []) {
  const abs = path.join(REPO, relDir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    // Test files are excluded: their fixtures deliberately CONTAIN the
    // hazardous forms as test data, so scanning them flags the very
    // examples that prove the detectors work.
    else if (/\.(ya?ml|sh|mjs)$/.test(entry.name) && !/\.test\.(mjs|sh)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function shellBearingFiles() {
  return [...walk(".github/workflows"), ...walk("scripts")];
}

const SHELL_FILES = shellBearingFiles();

describe("ci.yml job hygiene", () => {
  test("the parser found a plausible set of jobs", () => {
    // Guards the parser itself: every assertion below is vacuous if this
    // silently returns {}.
    assert.ok(Object.keys(JOBS).length >= 15, `only found ${Object.keys(JOBS).length} jobs`);
    for (const expected of ["lint", "migrate", "perf-budget", "test-web"]) {
      assert.ok(JOBS[expected], `expected to find job "${expected}"`);
    }
  });

  test("every job declares a job-level timeout-minutes", () => {
    // Without it a job inherits GitHub's 6-hour default. Observed real
    // hangs: a Lighthouse job at 13+ minutes, Playwright at 11m28s against
    // a ~2min norm.
    const missing = jobsMissingTimeout(JOBS);
    assert.deepEqual(missing, [], `jobs without a timeout guard: ${missing.join(", ")}`);
  });

  test("every badge-publishing job declares permissions.contents: write", () => {
    // The repo default is read-only, and an explicit permissions block sets
    // every unlisted scope to none. This caused a silent post-merge 403
    // twice (perf-budget, then test-e2e-web) -- and it can only fail
    // post-merge, since the publish step is push-to-main only and a PR
    // structurally cannot exercise it.
    const offenders = badgeJobsMissingWrite(JOBS);
    assert.deepEqual(offenders, [], `badge jobs missing contents:write: ${offenders.join(", ")}`);
  });

  test("migrate lists `changes` directly in needs", () => {
    // Deploy-critical and subtle: migrate gates on
    // !contains(needs.*.result, 'failure'), and a job whose own dependency
    // failed resolves to `skipped`, not `failure`. Without `changes` listed
    // directly, a changes-job failure cascades to skipped and sails through.
    const deps = needsList(JOBS.migrate);
    assert.ok(deps.length > 0, "could not parse migrate's needs list");
    assert.ok(deps.includes("changes"), `migrate.needs must list "changes"; found: ${deps.join(", ")}`);
  });
});

describe("gh CLI usage hazards", () => {
  test("no `gh api -f key=@path` anywhere (only -F reads files)", () => {
    // -f treats `@...` as a literal string, so this silently posts the path
    // instead of the file. Self-hiding: it also destroys the HTML marker
    // the step's own find-existing-comment lookup depends on, so the next
    // run creates a fresh comment and the cycle repeats forever.
    for (const file of SHELL_FILES) {
      const hits = findFileFlagMisuse(read(file));
      assert.deepEqual(hits, [], `${file} uses -f with @file; use -F instead`);
    }
  });

  test("no `--paginate` with a value-CONSTRUCTING jq filter", () => {
    // Narrower than CLAUDE.md's prose, deliberately: the filter runs once
    // per page, which is harmless for a stream of scalars and broken for
    // `--jq '[...]'`, where each page emits its own complete document.
    // Three correct stream-style usages are live today.
    for (const file of SHELL_FILES) {
      const hits = findConstructingPaginateJq(read(file));
      assert.deepEqual(hits, [], `${file}: fetch with --slurp and shape it downstream`);
    }
  });
});

describe("service worker / API query sync", () => {
  test("sw.js's public allowlist matches api.ts's query byte-for-byte", () => {
    // sw.js allowlists the exact canonical query TEXT, not an operation
    // name (caller-controlled and trivially spoofed). Drift means the real
    // request stops matching, or the allowlist stops describing what it
    // claims to. Currently only caught by a full Playwright run.
    const allowlisted = [...read("apps/web/public/sw.js").matchAll(/"(query ProductsPaged[^"]*)"/g)].map(
      (m) => m[1],
    );
    assert.equal(allowlisted.length, 1, "expected exactly one allowlisted ProductsPaged query");

    const raw = /const PRODUCTS_PAGED_QUERY = minifyGql\(`([\s\S]*?)`\)/.exec(
      read("apps/web/src/lib/api.ts"),
    );
    assert.ok(raw, "could not locate PRODUCTS_PAGED_QUERY in api.ts");
    assert.equal(allowlisted[0], raw[1].replace(/\s+/g, " ").trim());
  });
});

// These activate on their own once packages/ exists, rather than failing on
// a repo that has no workspace packages yet.
describe("workspace packages", () => {
  const packagesDir = path.join(REPO, "packages");
  // A directory is only a workspace package if it actually has a manifest;
  // otherwise a stray folder under packages/ would impose Dockerfile
  // requirements that do not apply to it.
  const packageNames = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .filter((d) => existsSync(path.join(packagesDir, d.name, "package.json")))
        .map((d) => d.name)
    : [];

  test("every workspace package's manifest is COPYd into every app image", () => {
    // The root package.json can declare a workspace package as a
    // dependency, and every app Dockerfile copies that root manifest -- so
    // a root-level `pnpm install` fails outright unless the package's own
    // manifest is present. This escaped to CI on apps/api, whose Dockerfile
    // was not updated alongside apps/web's.
    for (const name of packageNames) {
      // escapeRegExp: a directory name containing `.` would otherwise let a
      // different package's path satisfy the assertion.
      // Source AND destination: copying the manifest somewhere else would
      // satisfy a source-only check while leaving the workspace install
      // just as broken.
      const rel = `packages/${escapeRegExp(name)}/package\\.json`;
      const expected = new RegExp(`COPY\\s+${rel}\\s+(?:\\./)?${rel}`);
      for (const dockerfile of APP_DOCKERFILES) {
        assert.match(read(dockerfile), expected, `${dockerfile} must COPY packages/${name}/package.json`);
      }
    }
  });

  test("the changes filter actively covers packages/** for web and docker", () => {
    // apps/web depends on the shared config package and next.config.ts
    // imports it on the boot path, while apps/web/Dockerfile copies
    // packages/ into the image. Without these entries a config-only change
    // silently skips the web build, the web tests, and every Docker job.
    if (packageNames.length === 0) return;
    const filters = extractFiltersBlock(CI_YML);
    assert.ok(filters, "could not locate the paths-filter `filters:` block");
    for (const key of ["web", "docker"]) {
      // Scoped to the filters block: `web:` appears twice in this file, so
      // a whole-file lookup can read an unrelated mapping.
      const entries = filterEntries(filters, key);
      assert.ok(entries, `could not locate the "${key}" path filter`);
      assert.ok(
        entries.includes("packages/**"),
        `the "${key}" filter must actively include packages/** (found: ${entries.join(", ")})`,
      );
    }
  });
});
