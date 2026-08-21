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
