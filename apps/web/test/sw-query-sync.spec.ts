import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTS_PAGED_QUERY } from "@/lib/api";

// Asserts that public/sw.js's allowlist still contains the exact query the
// app actually sends.
//
// WHY THIS DUPLICATION EXISTS AT ALL, since the obvious fix is "just import
// it": sw.js is a static file the browser loads directly as a service
// worker. It cannot import from src/. So the query text is necessarily
// written out twice, and the only thing that can keep the copies honest is
// an assertion.
//
// WHAT BREAKS WHEN THEY DRIFT, and why nobody notices: the allowlist is an
// exact match (`PUBLIC_GRAPHQL_QUERIES.has(query.trim())`). Add a field to
// the query and the worker simply stops intercepting it -- no error, no
// warning, no wrong data. The stale-while-revalidate shell caching that
// exists to hide Render's cold starts just quietly stops working. It fails
// safe, which is exactly why it fails silently.
//
// This drift is not hypothetical: it is live in PR #134 right now, where
// the query gained `updatedAt` and the allowlist did not.
//
// The e2e suite does catch it -- sw-cache-isolation.spec.ts waits for the
// real request to land in the cache and times out when it doesn't. But that
// needs Postgres, the API, a built web server and a real browser, and it
// only runs when the path filter says so. This runs in milliseconds on
// every `pnpm --filter web test`, which is where a one-word query change
// should be caught.

const SW_SOURCE = readFileSync(
  join(__dirname, "..", "public", "sw.js"),
  "utf8",
);

/** Every query string in sw.js's PUBLIC_GRAPHQL_QUERIES set. */
function allowlistedQueries(): string[] {
  const block = SW_SOURCE.match(
    /PUBLIC_GRAPHQL_QUERIES = new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!block) throw new Error("PUBLIC_GRAPHQL_QUERIES not found in sw.js");
  return [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  );
}

describe("service worker query allowlist", () => {
  it("contains the exact query fetchProductsPaged sends", () => {
    // Compared against the real exported constant, not a third hardcoded
    // copy -- a copy would agree with itself while the app diverged, which
    // is precisely the failure mode this is meant to prevent.
    expect(allowlistedQueries()).toContain(PRODUCTS_PAGED_QUERY);
  });

  it("matches byte-for-byte, since the worker compares with ===", () => {
    // Spelled out separately because "contains" could pass on a
    // whitespace-normalised near-match in some future refactor of this
    // test, while the worker's Set.has() would still reject it.
    const match = allowlistedQueries().find((q) => q === PRODUCTS_PAGED_QUERY);
    expect(
      match,
      "sw.js's allowlist has drifted from src/lib/api.ts. The worker will " +
        "silently stop caching the catalogue query. Update " +
        "PUBLIC_GRAPHQL_QUERIES in apps/web/public/sw.js to the exact " +
        `string:\n\n${PRODUCTS_PAGED_QUERY}\n`,
    ).toBeDefined();
  });

  it("holds only queries the app actually sends", () => {
    // The other direction. A leftover entry is not dangerous the way a
    // missing one is, but it is dead config that implies a request the app
    // no longer makes -- and it would let a stale query keep being cached
    // if anything ever sent it.
    expect(allowlistedQueries()).toEqual([PRODUCTS_PAGED_QUERY]);
  });
});
