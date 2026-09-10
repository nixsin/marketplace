/**
 * Whether an image should skip Next's image optimizer.
 *
 * THE PROBLEM THIS SOLVES, measured on production: every product image
 * was being requested as
 *
 *   https://laxair.shop/_next/image?url=https%3A%2F%2Fimages.laxair.shop%2F...
 *
 * -- the ORIGIN, not the CDN. Next fetched from R2 server-side, ran the
 * optimizer, and served the result from Render in Oregon with
 * `cf-cache-status: DYNAMIC`, at ~1.86s per image. The R2 edge cache was
 * working perfectly and no user was reaching it, because the browser
 * never requested the blob URL at all.
 *
 * SVG IS THE CLEAR CASE. The optimizer cannot meaningfully process a
 * vector image -- it passes SVGs through unchanged, which is exactly why
 * `dangerouslyAllowSVG` has to be enabled for them to work at all. So for
 * every product image today the optimizer adds a proxy hop, a cold-start
 * dependency and an origin round trip, in exchange for nothing.
 *
 * Rasters are deliberately left alone. When sellers upload real photos
 * (#93) the optimizer earns its cost -- resizing and WebP conversion are
 * real work that a CDN hop does not replace.
 */

/** Extensions the optimizer genuinely improves. */
const OPTIMIZABLE = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;

/**
 * True when the image should be served directly rather than proxied.
 *
 * Conservative by construction: anything not recognisably a raster keeps
 * the current behaviour, so an unfamiliar URL never silently loses
 * optimization it was relying on.
 */
export function shouldBypassOptimizer(src: string | null | undefined): boolean {
  if (!src) return false;
  // A vector image gains nothing from the optimizer and loses the edge.
  if (/\.svg(\?|#|$)/i.test(src)) return true;
  // Anything the optimizer can actually work on keeps going through it.
  if (OPTIMIZABLE.test(src)) return false;
  // No recognisable extension -- a future signed or extensionless URL.
  // Leave it optimized: that is the existing behaviour, and quietly
  // bypassing could serve a full-resolution original to a phone.
  return false;
}

/**
 * The origin product images are actually fetched from, or null when blob
 * storage is not configured (or is configured with an unusable value).
 *
 * Exists so the layout can preconnect to it. That hint is only worth
 * anything BECAUSE of `shouldBypassOptimizer` above: once the browser
 * stops proxying images through our own origin, the LCP image lives on a
 * third-party host the document has never spoken to, so the request pays
 * a fresh DNS + TCP + TLS handshake before a single byte moves. Measured
 * on production `/hi?page=2`: `resourceLoadDelay` 485 ms against a
 * `resourceLoadDuration` of 147 ms -- most of the wait was getting to the
 * host, not transferring from it.
 *
 * `new URL()` rather than string handling, and the try/catch is
 * load-bearing for the same reason it is on `getApiOrigin`: this runs at
 * module load, which for a layout is during Next's static generation, so
 * an unset or relative value would fail the whole build rather than one
 * image. Null means "no separate origin worth a hint", which is the
 * correct answer for both a missing value and a same-origin one.
 */
export function blobOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_BLOB_BASE_URL ?? "";
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}
