import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guards the production database against the exact failure that took
// migrations down on 2026-08-21.
//
// Render provider v1.9.1 sends null for any optional+computed attribute the
// configuration omits. The first apply therefore cleared the imported IP
// allow-list, GitHub Actions lost access to the external endpoint, and
// `prisma migrate deploy` failed with P1017. The API stayed healthy the whole
// time because it uses the internal connection string, which is why it looked
// like a transient blip rather than a config change.
//
// `terraform providers schema -json` lists exactly SIX such attributes on
// render_postgres. Every one of them must be accounted for: either declared
// in the resource (so Terraform asserts it) or listed in ignore_changes (so
// Terraform plans it from prior state instead of null). An attribute that is
// neither is the next allow-list.
//
// This is a static check on purpose. A terraform plan test cannot prove the
// point: these attributes are not driven by variables, so there is nothing to
// perturb, and asserting "no diff" passes whether or not ignore_changes is
// present -- a vacuous test. What can actually regress is someone deleting or
// misspelling a name in the list, and that is what this catches.

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER_DIR = join(HERE, "..", "..", "infra", "terraform", "render");
const MAIN_TF = join(RENDER_DIR, "main.tf");
const LOCK_FILE = join(RENDER_DIR, ".terraform.lock.hcl");

/**
 * The provider version OPTIONAL_COMPUTED below was derived from.
 *
 * This pin is what makes a hard-coded list safe. The list can only go stale
 * when the provider changes, and the committed lockfile records exactly which
 * version is in use -- so a bump trips the assertion below and forces the
 * list to be re-derived, instead of silently leaving a new attribute in the
 * "omitted" bucket that this whole file exists to keep empty.
 *
 * Re-derive with:
 *   terraform -chdir=infra/terraform/render init -backend=false
 *   terraform -chdir=infra/terraform/render providers schema -json \\
 *     | jq -r \'.provider_schemas[].resource_schemas.render_postgres.block.attributes
 *              | to_entries[] | select(.value.optional and .value.computed) | .key\'
 */
const DERIVED_FROM_PROVIDER_VERSION = "1.9.1";

/**
 * Every optional+computed attribute on render_postgres, from the provider
 * schema. If a provider upgrade adds one, add it here and decide which side
 * it belongs on -- that decision is the whole point of this file.
 */
const OPTIONAL_COMPUTED = [
  "database_name",
  "database_user",
  "disk_size_gb",
  "high_availability_enabled",
  "ip_allow_list",
  "log_stream_override",
];

/** Attributes deliberately declared, so Terraform enforces their value. */
const MUST_BE_DECLARED = ["ip_allow_list"];

/** Attributes deliberately ignored, so Terraform preserves the live value. */
const MUST_BE_IGNORED = [
  "database_name",
  "database_user",
  "disk_size_gb",
  "high_availability_enabled",
  "log_stream_override",
];

/**
 * Removes HCL comments so a commented-out safeguard cannot satisfy a regex.
 *
 * Verified necessary, not speculative: with `ip_allow_list` wrapped in a
 * block comment, the first version of this guard passed 5/5 while the
 * production database had no allow-list at all. `#` line comments happened
 * to be safe (they precede the keyword, so an anchored match fails), but
 * block comments are not, and neither is the unanchored `cidr_block` check.
 *
 * String-aware because stripping `//` naively would corrupt any URL in a
 * quoted value. Walks the source tracking quote state and escapes, treating
 * a comment marker as a comment only outside a string.
 *
 * Does not handle heredocs; this stack uses none, and one would have to
 * contain a comment marker to matter.
 */
export function stripHclComments(src) {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];

    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "#" || (c === "/" && next === "/")) {
      while (i < src.length && src[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

function postgresBlock() {
  const src = stripHclComments(readFileSync(MAIN_TF, "utf8"));
  const start = src.indexOf('resource "render_postgres" "main"');
  assert.notEqual(start, -1, "render_postgres.main not found in main.tf");
  // Ends at the next top-level resource/data/import block.
  const rest = src.slice(start + 1);
  const next = rest.search(/^(resource|data|import|locals|variable) /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function ignoredAttributes(block) {
  const m = block.match(/ignore_changes\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((entry) => entry.replace(/#.*$/gm, "").trim())
    .filter(Boolean);
}

describe("render_postgres optional+computed attributes", () => {
  test("the attribute list is still valid for the locked provider", () => {
    // Without this, a provider upgrade could introduce a seventh
    // optional+computed attribute and every other test here would still
    // pass while that attribute sat unaccounted for -- the exact regression
    // class this file exists to prevent, reintroduced through the back door.
    //
    // The list is hard-coded rather than read from `terraform providers
    // schema` at test time on purpose: that command needs a `terraform init`
    // and a provider download, which would make an offline or network-
    // restricted run pass vacuously. Pinning to the locked version keeps the
    // check deterministic while still refusing to go quietly stale.
    // Scoped to the render provider's own block, not the first `version =`
    // in the file. Only one provider is locked today, but a second one
    // sorting before render-oss would otherwise make this read the wrong
    // version and pass while the render list was stale -- the same
    // silently-wrong-by-omission shape this file exists to catch.
    const lock = readFileSync(LOCK_FILE, "utf8");
    const block = lock.match(
      /provider\s+"registry\.terraform\.io\/render-oss\/render"\s*\{([^}]*)\}/,
    )?.[1];
    assert.ok(block, "render-oss/render not found in .terraform.lock.hcl");
    const version = block.match(/version\s*=\s*"([^"]+)"/)?.[1];

    assert.equal(
      version,
      DERIVED_FROM_PROVIDER_VERSION,
      `the render provider moved to ${version}, but OPTIONAL_COMPUTED was ` +
        `derived from ${DERIVED_FROM_PROVIDER_VERSION}. Re-derive it from the ` +
        `new schema (see the comment above DERIVED_FROM_PROVIDER_VERSION), ` +
        `decide whether each new attribute should be declared or ignored, ` +
        `then update this constant.`,
    );
  });

  test("every one is either declared or ignored, never omitted", () => {
    // The core invariant. An omitted attribute is sent as null on the next
    // apply, which is how the allow-list was wiped.
    const block = postgresBlock();
    const ignored = ignoredAttributes(block);

    const unaccounted = OPTIONAL_COMPUTED.filter((attr) => {
      const declared = new RegExp(`^\\s*${attr}\\s*=`, "m").test(block);
      return !declared && !ignored.includes(attr);
    });

    assert.deepEqual(
      unaccounted,
      [],
      `these render_postgres attributes are neither declared nor ignored, so ` +
        `the provider will clear them on the next apply: ${unaccounted.join(", ")}`,
    );
  });

  test("the allow-list is declared, not ignored", () => {
    // Declared rather than ignored on purpose: GitHub Actions needs the
    // external endpoint to run migrations, so Terraform should assert this
    // value rather than accept whatever the dashboard happens to hold.
    const block = postgresBlock();
    for (const attr of MUST_BE_DECLARED) {
      assert.match(
        block,
        new RegExp(`^\\s*${attr}\\s*=`, "m"),
        `${attr} must be declared explicitly`,
      );
      assert.ok(
        !ignoredAttributes(block).includes(attr),
        `${attr} must not be in ignore_changes -- it is meant to be enforced`,
      );
    }
    assert.match(block, /cidr_block\s*=\s*"0\.0\.0\.0\/0"/);
  });

  test("the five unreadable attributes stay ignored, spelled correctly", () => {
    // Ignored rather than declared because the live database name and user
    // are readable only from the connection secret, and declaring a WRONG
    // value plans a replacement of the production database. A typo here
    // silently drops one back into the "omitted" bucket.
    const ignored = ignoredAttributes(postgresBlock());
    for (const attr of MUST_BE_IGNORED) {
      assert.ok(
        ignored.includes(attr),
        `${attr} must remain in ignore_changes; found: ${ignored.join(", ")}`,
      );
    }
  });

  test("destruction of the production database stays blocked", () => {
    // Unrelated to the clearing bug, but it sits in the same lifecycle block
    // and is the guard that turns a replacement plan into a loud failure
    // rather than a dropped database.
    assert.match(postgresBlock(), /prevent_destroy\s*=\s*true/);
  });
});

describe("stripHclComments", () => {
  // These exist because the guard above was genuinely defeatable before it
  // stripped comments: wrapping ip_allow_list in /* */ left all five tests
  // passing while production had no allow-list.
  test("removes block comments, so a commented-out safeguard cannot pass", () => {
    const src = `resource "x" {\n/*\n  ip_allow_list = [{}]\n*/\n}`;
    assert.ok(!/^\s*ip_allow_list\s*=/m.test(stripHclComments(src)));
  });

  test("removes # and // line comments", () => {
    assert.ok(!/prevent_destroy/.test(stripHclComments("# prevent_destroy = true")));
    assert.ok(!/prevent_destroy/.test(stripHclComments("// prevent_destroy = true")));
  });

  test("keeps real configuration next to comments", () => {
    const out = stripHclComments(`a = 1 # trailing\n/* gone */\nb = 2`);
    assert.match(out, /a = 1/);
    assert.match(out, /b = 2/);
    assert.ok(!out.includes("trailing"));
    assert.ok(!out.includes("gone"));
  });

  test("does not corrupt // or # inside quoted strings", () => {
    // The reason this is string-aware rather than a pair of regexes: a naive
    // // strip eats the rest of every URL-bearing line.
    const out = stripHclComments('repo_url = "https://github.com/nixsin/marketplace"');
    assert.match(out, /https:\/\/github\.com\/nixsin\/marketplace/);
    assert.match(stripHclComments('description = "a # b"'), /a # b/);
  });

  test("handles an escaped quote without losing string state", () => {
    const out = stripHclComments('a = "he said \\"hi\\"" // comment');
    assert.ok(!out.includes("comment"));
    assert.match(out, /he said/);
  });
});
