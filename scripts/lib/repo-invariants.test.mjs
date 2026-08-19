// Repo invariants that CLAUDE.md previously stated only as prose.
//
// Each rule below is one this repo has already been bitten by, or one that
// silently rots if nobody remembers it. Prose relies on the reader having
// read the right paragraph at the right moment; these run on every PR.
//
// Deliberately dependency-free (string/regex over the raw files, no YAML
// parser). `test-ci-scripts` runs with no `pnpm install` at all -- its own
// comment in ci.yml calls that out as the reason it can stay unconditional
// and unfiltered. Adding a parser dependency here would quietly cost that
// property, which is worth more than prettier assertions.
//
// A note on translating prose into tests, learned while writing these: the
// prose is a summary aimed at a human who will apply judgment, so a literal
// transcription over-fires. CLAUDE.md's "never combine `gh api --paginate
// --jq`" reads as absolute, but three live, *correct* usages exist -- the
// real hazard is narrower (see the last test). A test that cries wolf gets
// ignored, which is the same failure mode as a required check that fails
// 70% of the time. Each rule's exact boundary was checked against the
// current repo before being asserted.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");
const CI_YML = read(".github/workflows/ci.yml");
const APP_DOCKERFILES = ["apps/api/Dockerfile", "apps/web/Dockerfile"];

// Splits ci.yml into { jobId: blockText }. Top-level jobs sit at exactly two
// spaces of indent; a job's block runs until the next such line.
function ciJobBlocks() {
  const lines = CI_YML.split("\n");
  const blocks = {};
  let id = null;
  let buf = [];
  for (const line of lines) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      if (id) blocks[id] = buf.join("\n");
      id = m[1];
      buf = [];
    } else if (id) {
      buf.push(line);
    }
  }
  if (id) blocks[id] = buf.join("\n");
  // `jobs:` is the only top-level key whose children match the pattern, but
  // guard anyway so a future top-level key can't silently become a "job".
  return Object.fromEntries(
    Object.entries(blocks).filter(([, body]) => /^\s+runs-on:/m.test(body)),
  );
}

const JOBS = ciJobBlocks();

describe("ci.yml job hygiene", () => {
  test("the block splitter found a plausible set of jobs", () => {
    // Guards the parser itself -- every assertion below is vacuous if this
    // silently returns {}.
    assert.ok(Object.keys(JOBS).length >= 15, `only found ${Object.keys(JOBS).length} jobs`);
    for (const expected of ["lint", "migrate", "perf-budget", "test-web"]) {
      assert.ok(JOBS[expected], `expected to find job "${expected}"`);
    }
  });

  test("every job declares timeout-minutes", () => {
    // Without it a job inherits GitHub's 6-hour default. Observed real
    // hangs: a Lighthouse job at 13+ minutes, Playwright at 11m28s against
    // a ~2min norm.
    const missing = Object.entries(JOBS)
      .filter(([, body]) => !/^\s+timeout-minutes:/m.test(body))
      .map(([id]) => id);
    assert.deepEqual(missing, [], `jobs without a timeout guard: ${missing.join(", ")}`);
  });

  test("every job that publishes a badge declares contents: write", () => {
    // The repo default is read-only, and an explicit `permissions:` block
    // sets every unlisted scope to none. This has caused a real, silent
    // post-merge 403 twice (perf-budget, then test-e2e-web) -- and it can
    // only fail post-merge, since the publish step is push-to-main only and
    // a PR structurally cannot exercise it.
    const offenders = Object.entries(JOBS)
      .filter(([, body]) => body.includes("publish-badge.sh"))
      .filter(([, body]) => !/^\s+contents:\s*write\s*$/m.test(body))
      .map(([id]) => id);
    assert.deepEqual(
      offenders,
      [],
      `badge-publishing jobs missing permissions.contents=write: ${offenders.join(", ")}`,
    );
  });

  test("migrate lists `changes` in needs", () => {
    // Subtle and deploy-critical: migrate gates on
    // !contains(needs.*.result, 'failure'), and a job whose own dependency
    // failed resolves to `skipped`, not `failure`. Without `changes` listed
    // directly, a changes-job failure would cascade to skipped and sail
    // straight through the gate.
    //
    // Parses the needs LIST specifically rather than searching the job
    // block for the word. A first version used /needs:.*changes/s, which
    // matched `needs.*.result` mentions in this job's own long comments and
    // so could never fail -- caught by mutating the file and finding the
    // test still green.
    const block = /\n\s+needs:\s*\n?\s*\[([\s\S]*?)\]/.exec(JOBS.migrate);
    assert.ok(block, "could not locate migrate's needs list");
    const deps = block[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    assert.ok(
      deps.includes("changes"),
      `migrate.needs must list "changes" directly; found: ${deps.join(", ")}`,
    );
  });
});

describe("gh CLI usage hazards", () => {
  const shellSources = [
    ".github/workflows/ci.yml",
    ".github/workflows/pr-reconciliation.yml",
  ].filter((f) => existsSync(path.join(REPO, f)));

  test("no `gh api -f key=@path` (only -F reads files)", () => {
    // -f treats `@...` as a literal string, so this silently posts the
    // seven-character path instead of the file. Self-hiding: it also
    // destroys the HTML marker the step's own find-existing-comment lookup
    // depends on, so the next run creates a fresh comment and the cycle
    // repeats. CLAUDE.md asks for exactly this grep.
    for (const file of shellSources) {
      const hits = [...read(file).matchAll(/-f\s+[a-z_]+=@/g)].map((m) => m[0]);
      assert.deepEqual(hits, [], `${file} uses -f with @file; use -F instead`);
    }
  });

  test("no `--paginate --jq` where the filter CONSTRUCTS a value", () => {
    // Narrower than CLAUDE.md's prose, deliberately. --paginate --jq runs
    // the filter once per page. That is fine when the filter emits a stream
    // of scalars (extra pages just append more lines) -- three such usages
    // exist today and are correct. It breaks when the filter builds a JSON
    // value, e.g. --jq '[...]', because each page emits its own complete
    // array and a downstream JSON.parse sees several concatenated
    // documents. Only the constructing form is asserted against.
    for (const file of shellSources) {
      const hits = [...read(file).matchAll(/--paginate[^\n]*--jq\s+'[[{]/g)].map((m) => m[0]);
      assert.deepEqual(
        hits,
        [],
        `${file} pipes --paginate through a value-constructing --jq; fetch with --slurp and shape it downstream`,
      );
    }
  });
});

describe("service worker / API query sync", () => {
  test("sw.js's public allowlist matches api.ts's query byte-for-byte", () => {
    // sw.js allowlists the exact canonical query TEXT (not an operation
    // name, which is caller-controlled and trivially spoofed). Drift means
    // the real app's request stops matching and silently loses its cache --
    // or, worse, that the allowlist stops describing what it claims to.
    // Currently only caught by a full Playwright e2e run; this catches it
    // in milliseconds.
    const sw = read("apps/web/public/sw.js");
    const api = read("apps/web/src/lib/api.ts");

    const allowlisted = [...sw.matchAll(/"(query ProductsPaged[^"]*)"/g)].map((m) => m[1]);
    assert.equal(allowlisted.length, 1, "expected exactly one allowlisted ProductsPaged query");

    const raw = /const PRODUCTS_PAGED_QUERY = minifyGql\(`([\s\S]*?)`\)/.exec(api);
    assert.ok(raw, "could not locate PRODUCTS_PAGED_QUERY in api.ts");
    const minified = raw[1].replace(/\s+/g, " ").trim();

    assert.equal(allowlisted[0], minified);
  });
});

// These activate on their own once packages/ exists -- they are written to
// pass vacuously before that rather than to fail on a repo that has no
// workspace packages yet.
describe("workspace packages", () => {
  const packagesDir = path.join(REPO, "packages");
  const packageNames = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  test("every workspace package's manifest is COPYd into every app image", () => {
    // The root package.json can declare a workspace package as a
    // dependency, and every app Dockerfile copies that root manifest -- so
    // a root-level `pnpm install` fails outright unless the package's own
    // manifest is present too. This escaped to CI on apps/api: apps/web's
    // Dockerfile was updated, apps/api's was not.
    for (const name of packageNames) {
      for (const dockerfile of APP_DOCKERFILES) {
        assert.match(
          read(dockerfile),
          new RegExp(`COPY\\s+packages/${name}/package\\.json`),
          `${dockerfile} must COPY packages/${name}/package.json`,
        );
      }
    }
  });

  test("the changes filter covers packages/** for web and docker", () => {
    // apps/web depends on the shared config package and next.config.ts
    // imports it on the boot path, while apps/web/Dockerfile copies
    // packages/ into the image. Without these entries a config-only change
    // silently skips the web build, the web tests, and every Docker job.
    if (packageNames.length === 0) return;
    const filter = /changes:[\s\S]*?\n {2}[a-z]/.exec(CI_YML)?.[0] ?? CI_YML;
    for (const key of ["web", "docker"]) {
      const block = new RegExp(`\\n\\s+${key}:\\n([\\s\\S]*?)(?=\\n\\s+[a-z_]+:\\n|$)`).exec(filter);
      assert.ok(block, `could not locate the "${key}" path filter`);
      assert.match(block[1], /packages\/\*\*/, `the "${key}" filter must include packages/**`);
    }
  });
});
