import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the specs in this directory against a STALE build.
 *
 * Everything else in apps/web/test boots a real `next start` against
 * `.next/`. When that directory is missing or left over from a failed
 * build, those specs fail with messages that point nowhere near the cause
 * -- "Server did not become ready", "element not found", "expected 0 to be
 * greater than 0".
 *
 * That misdirection is not hypothetical. It happened three times while
 * building this app, and once cost a long investigation into a
 * "catastrophic regression" that was a build which had failed on a type
 * error minutes earlier, its output half-written.
 *
 * This runs first and says the actual thing, so the other specs' failures
 * can be trusted to mean what they say.
 */
describe("build output is present and current", () => {
  const next = join(process.cwd(), ".next");

  it("a production build exists", () => {
    expect(
      existsSync(join(next, "build-manifest.json")),
      'No production build found. Run `pnpm --filter web build` first -- ' +
        "the specs in apps/web/test serve from .next/ and will otherwise " +
        "fail with unrelated-looking errors.",
    ).toBe(true);
  });

  it("the build completed rather than dying partway", () => {
    // A build killed mid-write leaves build-manifest.json behind without
    // the route data, which reads as "exists" while being unusable.
    const manifest = join(next, "build-manifest.json");
    if (!existsSync(manifest)) return; // the check above already reported it
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    expect(
      Object.keys(parsed.pages ?? {}).length,
      "The build manifest has no pages -- the build did not finish. " +
        "Rebuild before trusting any failure in this directory.",
    ).toBeGreaterThan(0);
  });

  it("the build is newer than the source it was built from", () => {
    // Editing a component and re-running these specs without rebuilding
    // tests the PREVIOUS version, which passes or fails for reasons
    // unrelated to the change in front of you.
    const builtAt = statSync(join(next, "build-manifest.json")).mtimeMs;
    const newest = ["src", "next.config.ts", "package.json"]
      .map((p) => join(process.cwd(), p))
      .filter(existsSync)
      .map((p) => newestMtime(p))
      .reduce((a, b) => Math.max(a, b), 0);

    expect(
      builtAt >= newest,
      "Source is newer than the build. Run `pnpm --filter web build` -- " +
        "these specs are currently exercising the previous version.",
    ).toBe(true);
  });
});

/** Newest mtime under a path, walking directories. */
function newestMtime(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.name !== "node_modules")
    .map((e) => newestMtime(join(path, e.name)))
    .reduce((a, b) => Math.max(a, b), stat.mtimeMs);
}
