#!/usr/bin/env node
/**
 * Strips `sourcesContent` from the browser source maps `next build` emits.
 *
 * WHY THIS EXISTS, and why not simply turning source maps off.
 *
 * `productionBrowserSourceMaps: true` is deliberate: it makes a production
 * stack trace resolve to a real file, line and column instead of a minified
 * offset, and it costs normal visitors nothing because browsers fetch maps
 * only when devtools are open. That benefit lives entirely in the map's
 * `mappings` field.
 *
 * `sourcesContent` is a different thing riding along: the complete original
 * text of every file, inlined. Measured on 2026-08-30 against production,
 * that was 2.25 MB of the 3.41 MB served -- 34 of our own source files
 * readable by anyone, `packages/config` among them, which publishes every
 * rate limit, page-size ceiling and token lifetime the app has. Those
 * constants are NOT in the shipped JavaScript (tree-shaking removes them --
 * verified: zero occurrences across the chunks, one occurrence per map), so
 * this really is a source-map artifact rather than a bundling problem, and
 * splitting the config package would not have fixed it.
 *
 * Stripping the text keeps every stack frame attributable and stops
 * publishing the source. Devtools will say "source not available" for a
 * frame and still name the file and line, which is the part worth having.
 *
 * Runs after `next build` in the `build` script, so the Docker image gets it
 * too -- apps/web/Dockerfile builds via `pnpm --filter web build`, not by
 * calling `next build` directly.
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

const STATIC_DIR = join(import.meta.dirname, "..", ".next", "static");

/** Every .map under a directory, recursively. */
async function findMaps(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A build that produced no static directory at all is a real problem,
    // but it is `next build`'s to report -- not this script's.
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findMaps(path)));
    else if (entry.name.endsWith(".map")) found.push(path);
  }
  return found;
}

/**
 * Removes `sourcesContent` from a map, INCLUDING an indexed one.
 *
 * A source map is not always flat. The compiled Tailwind stylesheet ships as
 * an index map -- `sections`, each with its own nested `map` -- and a check
 * for a top-level `sourcesContent` misses every one of them. That was the
 * first version of this script: it reported success while still publishing
 * 48 KB of CSS source, and the test asserting the field's absence is what
 * caught it.
 *
 * Returns whether anything was removed, so the caller only rewrites files it
 * actually changed.
 */
function stripContent(map) {
  let changed = false;
  if (map && typeof map === "object") {
    if ("sourcesContent" in map) {
      delete map.sourcesContent;
      changed = true;
    }
    for (const section of Array.isArray(map.sections) ? map.sections : []) {
      if (stripContent(section?.map)) changed = true;
    }
  }
  return changed;
}

const maps = await findMaps(STATIC_DIR);
let before = 0;
let after = 0;
let stripped = 0;

for (const path of maps) {
  before += (await stat(path)).size;
  const raw = await readFile(path, "utf8");

  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    // Left exactly as found rather than guessed at. A map this cannot parse
    // is one it must not rewrite -- a half-written file is worse than a
    // readable one.
    console.warn(`  ! could not parse, left as-is: ${path}`);
    after += raw.length;
    continue;
  }

  if (stripContent(map)) {
    stripped += 1;
    const out = JSON.stringify(map);
    await writeFile(path, out);
    after += Buffer.byteLength(out);
  } else {
    after += raw.length;
  }
}

const saved = before - after;
console.log(
  `  sourcemaps: stripped sourcesContent from ${stripped}/${maps.length} maps, ` +
    `${(before / 1024 / 1024).toFixed(2)} MB -> ${(after / 1024 / 1024).toFixed(2)} MB ` +
    `(-${(saved / 1024 / 1024).toFixed(2)} MB)`,
);
