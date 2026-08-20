import { readdirSync, readFileSync } from "node:fs";
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

  /**
   * Every NEXT_PUBLIC_* reference in the app's own sources, discovered
   * rather than listed. A hardcoded file list would quietly stop covering
   * a variable introduced anywhere else, which is the same class of silent
   * gap this whole test exists to close.
   */
  function collectReferences(dir: string, found: Set<string>): Set<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectReferences(full, found);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        for (const m of readFileSync(full, "utf8").matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
          found.add(m[0]);
        }
      }
    }
    return found;
  }

  const referenced = collectReferences(join(process.cwd(), "src"), new Set<string>());
  collectReferences(join(repoRoot, "packages", "config", "src"), referenced);
  for (const m of readFileSync(join(process.cwd(), "next.config.ts"), "utf8")
    .matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
    referenced.add(m[0]);
  }

  it("finds variables to check at all (guards against a silently empty scan)", () => {
    // Without this, a regex that stopped matching would make every
    // assertion below vacuously pass.
    expect(referenced.size).toBeGreaterThan(0);
  });

  it.each([...referenced])("%s is passed INTO the build, not merely mentioned", (name) => {
    // A plain substring check is not enough, and this is not theoretical:
    // removing only the `ARG` line while leaving `ENV NAME=$NAME` behind
    // left the build input unavailable while the test still passed. The
    // ENV line references the name, so `toContain` was satisfied by the
    // very state the test exists to reject -- and a comment mentioning
    // the variable would satisfy it too.
    //
    // Only two forms actually supply a value to `next build`:
    //   ARG NAME             (with or without a default)
    //   NAME=value  on the RUN line that invokes the build
    const declaredAsArg = new RegExp(`^\\s*ARG\\s+${name}(=|\\s|$)`, "m").test(
      dockerfile,
    );
    const setOnBuildRun = new RegExp(`${name}=\\S`).test(
      // Only the RUN block that actually runs the build counts.
      dockerfile.split(/^RUN /m).find((block) => block.includes("pnpm --filter web build")) ?? "",
    );

    expect(
      declaredAsArg || setOnBuildRun,
      `${name} is read by the app but never supplied to the Docker build. ` +
        "Add `ARG " + name + "` (an ENV line alone does not pass a value in), " +
        "or set it inline on the build RUN line.",
    ).toBe(true);
  });
});
