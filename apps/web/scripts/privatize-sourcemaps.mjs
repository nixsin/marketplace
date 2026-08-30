#!/usr/bin/env node
/**
 * Moves the browser source maps out of the publicly served tree, and points
 * each chunk at the gated route that serves them instead.
 *
 * WHY, and why not simply turning source maps off.
 *
 * `productionBrowserSourceMaps: true` is deliberate: a production stack trace
 * that resolves to a real file and line beats a minified offset, and browsers
 * fetch maps only with devtools open, so normal visitors never pay for them.
 * The problem was never that they exist -- it is that `next start` serves
 * everything under `.next/static`, so anyone could `curl` the map and read the
 * complete original text of 34 of our files. Measured against production on
 * 2026-08-30: 2.38 MB of inlined source, `packages/config` among it, which
 * publishes every rate limit and ceiling the app has.
 *
 * Stripping `sourcesContent` was the first attempt and it works, but it throws
 * away the useful half for everyone including us. Moving the maps behind a
 * token keeps them WHOLE for a session that holds it and returns 404 to
 * everyone else, which is strictly better: no public exposure, no loss.
 *
 * `.next/sourcemaps/` is safe because `next start` publicly serves only
 * `.next/static/**` -- verified directly, a file placed elsewhere under
 * `.next/` returns 404 at every path shape tried. The prod image copies the
 * whole `.next` directory (apps/web/Dockerfile), so the maps travel with it
 * and stay reachable to the route.
 *
 * Runs after `next build` in the `build` script so the Docker image gets it
 * too -- the Dockerfile builds via `pnpm --filter web build`, not by calling
 * `next build` directly.
 */
import { mkdir, readdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { SOURCEMAP_FILENAME } from "@medinstru/config/sourcemap-token";

const WEB_ROOT = join(import.meta.dirname, "..");
const STATIC_DIR = join(WEB_ROOT, ".next", "static");
const PRIVATE_DIR = join(WEB_ROOT, ".next", "sourcemaps");

/** Public path the gated route is mounted at. Must match the route folder. */
const ROUTE = "/sourcemaps";

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const all = await walk(STATIC_DIR);
const maps = all.filter((p) => p.endsWith(".map"));
const referencing = all.filter((p) => p.endsWith(".js") || p.endsWith(".css"));

if (maps.length === 0) {
  // Not an error on its own -- productionBrowserSourceMaps may be off. Said
  // out loud rather than passing silently, because a build that quietly stops
  // emitting maps would otherwise look identical to one this script handled.
  console.log("  sourcemaps: none found under .next/static — nothing to move");
  process.exit(0);
}

await mkdir(PRIVATE_DIR, { recursive: true });

let moved = 0;
let bytes = 0;
const names = new Set();

for (const path of maps) {
  // `basename`, not a lastIndexOf("/") -- node:path.join emits backslashes on
  // Windows, which would make the whole path the "filename" and quietly break
  // both the collision check below and the rename destination.
  const name = basename(path);

  // The SAME pattern the route serves, imported rather than restated. These
  // were two separate regexes and they disagreed: this script moved every
  // `.map` while the route served only this shape, so a map with any other
  // basename got moved, repointed, and then 404'd forever -- silently, since
  // the reference in the chunk still looked correct.
  //
  // Failing the build is deliberate. The alternative, leaving an unsupported
  // map in place, would publish exactly the source this whole change exists
  // to stop publishing.
  if (!SOURCEMAP_FILENAME.test(name)) {
    throw new Error(
      `source map "${name}" does not match the name the gated route serves ` +
        `(${SOURCEMAP_FILENAME}) — it would be moved and then permanently 404. ` +
        `Widen SOURCEMAP_FILENAME in packages/config to cover it.`,
    );
  }

  if (names.has(name)) {
    // Two maps with the same basename in different directories would collide
    // in the flat private directory and one would silently win. Refused
    // rather than resolved: a wrong map is worse than no map, and this has
    // never happened -- if it starts, the layout changed and the route's key
    // needs to change with it.
    throw new Error(
      `two source maps share the basename "${name}" — the private directory is flat and cannot hold both`,
    );
  }
  names.add(name);
  bytes += (await stat(path)).size;
  await rename(path, join(PRIVATE_DIR, name));
  moved += 1;
}

// Repoint every `//# sourceMappingURL=` at the gated route. Absolute, so it
// resolves from the origin root regardless of which directory the chunk was
// served from.
let repointed = 0;
for (const path of referencing) {
  const body = await readFile(path, "utf8");
  if (!body.includes("sourceMappingURL=")) continue;
  const next = body.replace(
    /sourceMappingURL=(?!\/|https?:)([^\s*'"]+\.map)/g,
    (_match, name) => `sourceMappingURL=${ROUTE}/${name}`,
  );
  if (next !== body) {
    await writeFile(path, next);
    repointed += 1;
  }
}

console.log(
  `  sourcemaps: moved ${moved} maps (${(bytes / 1024 / 1024).toFixed(2)} MB) out of the public tree, ` +
    `repointed ${repointed} files at ${ROUTE}/`,
);
