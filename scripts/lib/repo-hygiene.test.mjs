import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  scanForSecrets,
  extractRelativeLinks,
  headingSlugs,
} from "./repo-hygiene.mjs";
// Reused rather than restated. Two copies of the rule for what counts as
// importing the bootstrap helper is exactly the drift this whole change is
// about -- and the copy that fell behind would be the permissive one.
import { HELPER_IMPORT, stripComments } from "./ci-env-drift.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");

/** Every tracked file, from git -- so untracked scratch files are ignored. */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("scanForSecrets", () => {
  test("flags a value that looks like a real credential", () => {
    // Both of these initially passed silently: the keyword had to sit
    // immediately before the `=`, so `secret_access_key=` did not match,
    // and the AWS pattern required a word boundary after exactly 16
    // characters, which a quoted value never provides.
    assert.equal(
      scanForSecrets("f", 'secret_access_key = "K7pQm2XvR9tLzN4bW8sYc3JhF6dGa1eU"').length,  // scan-ignore: deliberate fixture
      1,
    );
    assert.equal(scanForSecrets("f", "AKIAQYLPMN5HXYZ12ABC").length, 1);  // scan-ignore: deliberate fixture
  });

  test("flags a private key block and a JWT", () => {
    assert.equal(scanForSecrets("f", "-----BEGIN RSA PRIVATE KEY-----").length, 1);  // scan-ignore: deliberate fixture
    assert.equal(
      scanForSecrets("f", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N").length,  // scan-ignore: deliberate fixture
      1,
    );
  });

  test("an explicit scan-ignore marker exempts a single line", () => {
    // The scanner flagged its OWN fixtures on the first real run. A
    // per-line marker rather than excluding the file: an exclusion hides
    // the exemption and would silently cover future additions too.
    const secret = 'api_key = "K7pQm2XvR9tLzN4bW8sYc3JhF6dGa1eU"';  // scan-ignore: fixture
    assert.equal(scanForSecrets("f", secret).length, 1);
    assert.equal(scanForSecrets("f", `${secret} // scan-ignore`).length, 0);
  });

  test("does NOT flag the name-only pattern this repo uses on purpose", () => {
    // The codebase stores env var NAMES and resolves values at call time.
    // A guard that fired on that would be disabled within a day.
    for (const line of [
      'accessKeyId: "BLOB_ACCESS_KEY_ID"',
      "KEY=${BLOB_SECRET_ACCESS_KEY}",
      "BLOB_SECRET_ACCESS_KEY=<secret>",
      "const k = process.env.BLOB_SECRET_ACCESS_KEY;",
      "token: abc123",
    ]) {
      assert.equal(scanForSecrets("f", line).length, 0, `should not flag: ${line}`);
    }
  });

  test("reports the line number, so a hit is actionable", () => {
    const [hit] = scanForSecrets("f", 'a\nb\napi_key = "K7pQm2XvR9tLzN4bW8sYc3JhF6dGa1eU"');  // scan-ignore: deliberate fixture
    assert.equal(hit.line, 3);
  });
});

describe("no tracked file contains a credential", () => {
  // The consequence is what makes this worth a test rather than a habit:
  // a committed key is in git history PERMANENTLY. Removing the line does
  // not remove it, and the only real remedy is rotating the key.
  test("the whole repository is clean", () => {
    const findings = [];
    for (const file of trackedFiles()) {
      if (/\.(png|jpe?g|gif|webp|svg|ico|lock)$|pnpm-lock/.test(file)) continue;
      const path = join(REPO, file);
      if (!existsSync(path)) continue;
      findings.push(...scanForSecrets(file, readFileSync(path, "utf8")));
    }
    assert.deepEqual(
      findings,
      [],
      `possible credentials committed:\n${findings.map((f) => `  ${f.path}:${f.line} (${f.kind})`).join("\n")}`,
    );
  });
});

describe("documentation cross-links resolve", () => {
  // The infrastructure docs are what someone reads DURING an incident,
  // when following a dead link costs exactly the time they do not have.
  const docs = trackedFiles().filter((f) => f.endsWith(".md"));

  test("found docs to check", () => {
    assert.ok(docs.length > 0);
  });

  test("every relative link points at a file that exists", () => {
    const broken = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO, doc), "utf8");
      for (const { target } of extractRelativeLinks(text)) {
        const resolved = join(REPO, dirname(doc), target);
        if (!existsSync(resolved)) broken.push(`${doc} -> ${target}`);
      }
    }
    assert.deepEqual(broken, [], `broken links:\n  ${broken.join("\n  ")}`);
  });

  test("every anchor matches a real heading", () => {
    // An anchor that looks right but does not resolve is the failure mode
    // here -- GitHub silently lands you at the top of the page.
    const broken = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO, doc), "utf8");
      for (const { target, anchor } of extractRelativeLinks(text)) {
        if (!anchor) continue;
        const resolved = join(REPO, dirname(doc), target);
        if (!existsSync(resolved)) continue;
        const slugs = headingSlugs(readFileSync(resolved, "utf8"));
        if (!slugs.includes(anchor)) broken.push(`${doc} -> ${target}#${anchor}`);
      }
    }
    assert.deepEqual(broken, [], `dead anchors:\n  ${broken.join("\n  ")}`);
  });
});

describe("e2e suites boot the app the way production does", () => {
  // configureApp exists so the app under test matches the real one, and says
  // so in its own comment. Six suites still bootstrapped by hand, and two had
  // already drifted: auth and organizations replicated only its ValidationPipe
  // line, so they ran without the correlation middleware, the correlation
  // exception filter, the CORS policy and the GraphQL cache-control patch --
  // in exactly the two suites covering authentication.
  //
  // Nothing failed when that happened, which is why this is a test rather than
  // a comment: the suites passed either way, they just proved less than they
  // appeared to.
  const specs = trackedFiles().filter((f) =>
    f.startsWith("apps/api/test/") && f.endsWith(".e2e-spec.ts"),
  );

  test("there are e2e suites to check", () => {
    // Guards the filter itself. A renamed directory would otherwise make this
    // whole block vacuously green.
    assert.ok(specs.length >= 4, `expected several e2e suites, found ${specs.length}`);
  });

  for (const spec of specs) {
    test(`${spec} uses bootstrapTestApp`, () => {
      // Comments stripped, or `// await bootstrapTestApp()` satisfies the
      // positive checks below while the suite boots nothing.
      const source = stripComments(readFileSync(join(REPO, spec), "utf8"));

      // Absence is half the check. On its own it passes for a suite that
      // stopped booting an app at all, or reaches one through some third
      // route -- so the positive half asserts the helper is really imported
      // and really called. Both halves, or the test's name is a claim its
      // body does not make.
      assert.ok(
        !source.includes("createNestApplication"),
        `${spec} builds its own Nest app. Use bootstrapTestApp from ` +
          `apps/api/test/helpers/bootstrap.ts so the suite runs the same ` +
          `configuration production does.`,
      );

      assert.match(
        source,
        HELPER_IMPORT,
        `${spec} must import bootstrapTestApp from ./helpers/bootstrap`,
      );

      assert.match(
        source,
        /(?<![\w$.])await[ \t]+bootstrapTestApp\s*\(/,
        `${spec} must await bootstrapTestApp -- importing it is not calling it`,
      );
    });
  }
});
