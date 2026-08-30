import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STATIC_DIR = join(import.meta.dirname, "..", ".next", "static");

function findMaps(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMaps(path));
    else if (entry.name.endsWith(".map")) out.push(path);
  }
  return out;
}

/**
 * Published source maps must carry mappings but NOT the original source.
 *
 * `productionBrowserSourceMaps: true` is deliberate -- a production stack
 * trace resolving to a real file and line is worth having, and browsers fetch
 * maps only with devtools open. `sourcesContent` is a separate thing riding
 * along: the complete text of every file, inlined and publicly readable.
 *
 * Measured before this was fixed: 2.25 MB of the 3.41 MB served, 34 of our own
 * files, `packages/config` among them -- which publishes every rate limit and
 * ceiling the app has. `scripts/strip-sourcemap-content.mjs` removes it after
 * `next build`.
 *
 * Asserted against the real build output rather than against the script,
 * because the failure this guards is a build-tool change quietly reinstating
 * the field, which a test of our own code could not see. `build-freshness`
 * keeps the output current.
 */
describe("published source maps", () => {
  const maps = findMaps(STATIC_DIR);

  it("finds maps to check at all", () => {
    // Without this, every assertion below passes vacuously the day the build
    // stops emitting maps or the path changes -- and the whole suite would
    // report green while checking nothing.
    expect(maps.length).toBeGreaterThan(0);
  });

  it("never inlines original source, at any nesting level", () => {
    // Checked recursively through `sections`, because a source map is not
    // always flat: the compiled stylesheet ships as an INDEX map, whose
    // content hides one level down. A top-level-only check passed while 48 KB
    // of CSS source was still being published -- which is how this assertion
    // earned its shape.
    const hasContent = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const map = node as { sourcesContent?: unknown; sections?: unknown };
      if (map.sourcesContent !== undefined) return true;
      return (Array.isArray(map.sections) ? map.sections : []).some(
        (section: { map?: unknown }) => hasContent(section?.map),
      );
    };

    const leaking = maps.filter((p) =>
      hasContent(JSON.parse(readFileSync(p, "utf8"))),
    );

    expect(
      leaking.map((p) => p.replace(STATIC_DIR, "")),
    ).toEqual([]);
  });

  it("keeps the fields a stack trace actually needs", () => {
    // The point of the strip is to lose the source TEXT, not the mapping.
    // A map with no `sources` could not name a file, which is the benefit
    // productionBrowserSourceMaps was turned on for.
    // An index map carries its mappings inside `sections` rather than at the
    // top level, so both shapes count as usable.
    const unusable = maps.filter((p) => {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as {
        sources?: unknown;
        mappings?: unknown;
        sections?: unknown;
      };
      const flat =
        Array.isArray(parsed.sources) && typeof parsed.mappings === "string";
      const indexed = Array.isArray(parsed.sections) && parsed.sections.length > 0;
      return !flat && !indexed;
    });

    expect(unusable.map((p) => p.replace(STATIC_DIR, ""))).toEqual([]);
  });

  it("does not publish the VALUE of any tunable from the shared config", () => {
    // The identifier NAMES survive, in the map's `names` array, and that is
    // accepted: knowing a per-phone rate limit exists is inferable from
    // behaviour anyway. The values are the operationally useful part --
    // #152 records the inquiry caps as an accepted DoS surface, and the
    // exact ceilings are what make reaching them cheap.
    const probes = [
      "INQUIRY_RATE_LIMIT_PER_PHONE = ",
      "INQUIRY_RATE_LIMIT_PER_IP = ",
      "PRODUCTS_MAX_OFFSET = ",
    ];
    const found = maps.flatMap((p) => {
      const raw = readFileSync(p, "utf8");
      return probes.filter((probe) => raw.includes(probe));
    });

    expect(found).toEqual([]);
  });
});
