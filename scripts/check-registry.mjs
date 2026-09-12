#!/usr/bin/env node
import { checkRegistry } from "./lib/check-registry.mjs";

/**
 * Preflight for dependency-freshness.yml: refuses to let the freshness
 * check run at all when the registry is not answering, because pnpm would
 * then report from its local metadata cache and the result would look
 * exactly like a healthy one.
 *
 * Usage:
 *   scripts/check-registry.mjs "$(pnpm config get registry)"
 *
 * Exits 0 when the registry served real package metadata, and 2 otherwise
 * -- never 1. The codes match scripts/check-outdated.mjs deliberately: 1
 * means "an actionable major was found", so reporting a registry outage
 * with it would send someone looking for an upgrade that does not exist.
 * That was a review finding against the shell version, where a failing
 * `pnpm config get registry` aborted the step under `bash -e` and exited
 * with pnpm's own status. Passing the value in as an argument is what
 * makes that case reachable here: an empty or missing argument is simply
 * "no usable registry", handled like any other.
 *
 * `process.exitCode`, never `process.exit()` -- the latter can terminate
 * before piped stdout has flushed.
 */
const [registry] = process.argv.slice(2);

const { ok, origin, reason } = await checkRegistry({ registry });

if (ok) {
  console.log(`check-registry: ${origin} served package metadata.`);
} else {
  // Only ever the ORIGIN, never the configured value: a registry URL can
  // carry userinfo, and this lands in a public workflow log.
  console.error(
    `check-registry: ${origin ?? "<no registry>"} ${reason} — refusing to report dependency freshness from pnpm's local metadata cache.`,
  );
  process.exitCode = 2;
}
