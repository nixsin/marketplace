import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The two preconnect hints, and the ways they break each other.
 *
 * Asserted against the SOURCE rather than a served response, and that is a
 * deliberate limitation rather than a shortcut. `NEXT_PUBLIC_BLOB_BASE_URL`
 * is inlined at BUILD time -- verified directly: a server built with `""`
 * and started with the variable set still emits no blob hint -- and the
 * build these suites run against sets it empty, so no real-HTTP test can
 * observe this one at all. The behaviour WAS verified over real HTTP by
 * building with a value and curling; what a test can still protect is the
 * source, which is where every failure mode below actually lives.
 *
 * Each is a one-line edit that looks like tidying and silently costs the
 * LCP image its connection.
 */
const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

/**
 * The source with every comment removed.
 *
 * Needed because the assertions below look for code that must NOT exist,
 * and the comments here deliberately QUOTE that code to explain why. A
 * naive search matches the explanation and fails on a correct file --
 * which it did, on the first attempt.
 */
function codeOnly(): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // {/* JSX */}
    .replace(/\/\*[\s\S]*?\*\//g, "") //             /* block */
    .replace(/^\s*\/\/.*$/gm, ""); //                   // line
}

/** The `<link rel="preconnect" ... />` elements, in source order. */
function preconnects(): string[] {
  return source.match(/<link\s+rel="preconnect"[\s\S]*?\/>/g) ?? [];
}

describe("preconnect hints", () => {
  it("emits exactly two, one per origin the page actually talks to", () => {
    // A third would mean a hint nobody checked against a real request.
    expect(preconnects()).toHaveLength(2);
  });

  it("keeps crossOrigin on the API hint and OFF the blob hint", () => {
    // THE test. Browsers pool connections per origin PER CORS MODE, so a
    // hint only helps if it matches the request that follows.
    //
    // The API fetch sends `credentials: "omit"` -> anonymous CORS.
    // The image is a plain <img src> that next/image renders with no
    // crossorigin attribute -> no-CORS. Copying the API's attribute onto
    // the blob hint reads as consistency and warms a pool nothing reuses:
    // the cost of the handshake, none of the benefit. Removing it from the
    // API hint breaks the other one the same way, so both are pinned.
    const [api, blob] = preconnects();
    expect(api).toContain("API_ORIGIN");
    expect(api).toContain('crossOrigin="anonymous"');

    expect(blob).toContain("BLOB_ORIGIN");
    expect(blob).not.toContain("crossOrigin");
  });

  it("does NOT suppress the blob hint when the two origins match", () => {
    // Caught in review. A `BLOB_ORIGIN !== API_ORIGIN` guard looks like
    // de-duplication and is the same mistake in reverse -- by the rule
    // above those are two different connections, so suppressing the
    // no-CORS one leaves the LCP image with nothing warmed. Verified by
    // building with both pointing at one origin: both links render.
    //
    // Asserted against the whole SOURCE, not the matched <link> element,
    // and that distinction is the test working rather than pedantry: the
    // guard would sit in the surrounding JSX conditional, outside the
    // element, so an element-scoped check passes while the regression is
    // present. Written that way first and caught by re-introducing the
    // bug -- which is the only reason it is written this way now.
    const code = codeOnly();
    expect(code).not.toMatch(/BLOB_ORIGIN\s*!==\s*API_ORIGIN/);
    expect(code).not.toMatch(/API_ORIGIN\s*!==\s*BLOB_ORIGIN/);
  });

  it("guards both hints on a null origin rather than rendering an empty href", () => {
    // `blobOrigin()`/`getApiOrigin()` return null for an unset or unusable
    // value; rendering that would emit href="" and send the browser after
    // the current document's own origin.
    for (const link of preconnects()) {
      expect(link).toMatch(/(API|BLOB)_ORIGIN/);
    }
    expect(source).toContain("API_ORIGIN !== null");
    expect(source).toContain("BLOB_ORIGIN !== null");
  });
});
