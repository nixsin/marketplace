import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NEXT_PUBLIC_* values are inlined at BUILD time, so a Docker build only
 * sees them if the Dockerfile takes them in -- either as an `ARG`, or set
 * inline on the `next build` RUN line. A variable set in Render's
 * dashboard but absent from the Dockerfile simply never arrives.
 *
 * This has now bitten twice, and both times it failed SILENTLY, which is
 * what makes it worth a test rather than a note:
 *
 *   NEXT_PUBLIC_SITE_URL   unset -> every WhatsApp share link and og:image
 *                          pointed at http://localhost:3000. Shipped to
 *                          production and was found by a person, not a
 *                          tool. That one now also has a build-time guard.
 *
 *   NEXT_PUBLIC_BLOB_BASE_URL  declared in Render but not in the
 *                          Dockerfile -> the build behaved exactly as if
 *                          no blob storage existed. R2 was serving fine,
 *                          the variable was set correctly, and every
 *                          product still pointed at its local path with
 *                          nothing anywhere reporting a problem.
 *
 * Neither is a logic bug any unit test would catch -- the code is correct
 * and simply never receives the value. The invariant that actually holds
 * is structural: if the app reads it, the Dockerfile must pass it.
 */
describe("every NEXT_PUBLIC_* the app reads is passed into the Docker build", () => {
  const repoRoot = join(process.cwd(), "..", "..");
  const dockerfile = readFileSync(
    join(process.cwd(), "Dockerfile"),
    "utf8",
  );

  /** Sources whose NEXT_PUBLIC_* references must all reach the build. */
  const sources = [
    join(process.cwd(), "next.config.ts"),
    join(repoRoot, "packages", "config", "src", "index.js"),
  ];

  const referenced = new Set<string>();
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
      referenced.add(match[0]);
    }
  }

  it("finds variables to check at all (guards against a silently empty scan)", () => {
    // Without this, a regex that stopped matching would make every
    // assertion below vacuously pass.
    expect(referenced.size).toBeGreaterThan(0);
  });

  it.each([...referenced])("%s is declared in the Dockerfile", (name) => {
    // Either form counts: `ARG NAME=...`, or `NAME=...` inline on the
    // build RUN line (which is how the build-identity values arrive).
    expect(dockerfile).toContain(name);
  });
});
