/**
 * Decides whether the npm registry is actually answering, so the freshness
 * check can tell "nothing is outdated" from "pnpm answered out of its local
 * cache because the registry was unreachable".
 *
 * It exists because `pnpm outdated`'s exit status cannot express the
 * difference. Measured rather than assumed: with `npm_config_registry`
 * pointed at a dead host, pnpm still exits 1, still writes ~7.5 KB of
 * well-formed JSON, and writes NOTHING to stderr -- and the parsed map is
 * byte-identical to a healthy run's, because both come from that cache.
 * The failure is silent and in the dangerous direction: a stale `latest`
 * UNDER-reports, so a new major goes unseen and the check passes.
 *
 * In a library with its own tests rather than inline in the workflow, for
 * the reason this repo already applies to pr-reconciliation and
 * ci-progress-comment: the workflow gathers inputs, the library decides.
 * Three review rounds on the shell version each found another way through,
 * every one of them untestable where it sat.
 */

/** The package whose metadata is fetched. Any real one does; this is small. */
export const PROBE_PACKAGE = "semver";

/**
 * The registry's origin, or null if it is not a usable http(s) URL.
 *
 * Origin specifically, because a registry URL can carry userinfo
 * (`https://user:pass@host/`) and the caller logs this value -- a raw
 * registry string in a public workflow log is a leaked credential.
 * `URL.origin` drops it. Raised in review.
 */
export function registryOrigin(registry) {
  if (typeof registry !== "string" || registry.trim() === "") return null;
  try {
    const url = new URL(registry.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * True only when the body is genuinely this package's metadata document.
 *
 * A 2xx is not enough, which was a review finding: a captive portal, a
 * proxy error page or an HTML login screen all answer 200, and discarding
 * the body (`curl -o /dev/null`) accepts every one of them. The `name`
 * field is what makes it the registry's answer rather than something
 * merely willing to respond.
 */
export function isPackageMetadata(body, pkg = PROBE_PACKAGE) {
  if (typeof body !== "string") return false;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.name === pkg
  );
}

/**
 * @returns {Promise<{ok: boolean, origin: string|null, reason: string}>}
 *
 * Never throws and never rejects: every failure is a reason, because the
 * caller's whole job is to turn one into a clean exit 2 rather than a
 * stack trace that reads like a dependency finding.
 */
export async function checkRegistry({
  registry,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  pkg = PROBE_PACKAGE,
} = {}) {
  const origin = registryOrigin(registry);
  // Covers an unset value, an empty one, and a `pnpm config get` that
  // failed -- the workflow cannot distinguish those and does not have to.
  if (origin === null) {
    return { ok: false, origin: null, reason: "no usable registry URL configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `redirect: "follow"` is the default and is stated rather than
    // inherited: the shell version used bare curl, which treats a 3xx as
    // success WITHOUT fetching the destination, so a redirect to anywhere
    // passed the probe. Raised in review.
    const response = await fetchImpl(`${origin}/${pkg}`, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, origin, reason: `responded ${response.status}` };
    }
    const body = await response.text();
    if (!isPackageMetadata(body, pkg)) {
      return { ok: false, origin, reason: `did not return ${pkg} metadata` };
    }
    return { ok: true, origin, reason: "ok" };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : `unreachable (${error?.message})`;
    return { ok: false, origin, reason };
  } finally {
    clearTimeout(timer);
  }
}
