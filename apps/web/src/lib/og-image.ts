// OpenGraph preview images.
//
// Why this exists: product images are stored as SVG (`/products/*.svg`) --
// the right choice for the page itself, since they are flat vector
// illustrations that stay crisp at any size for a fraction of the bytes.
// But SVG is NOT a valid OpenGraph image. Facebook's scraper, which
// WhatsApp shares, accepts JPEG, PNG, GIF and WebP only; handed an SVG it
// renders the card with a blank image well. The title and description
// still appear, which is exactly why this fails quietly: the link "works",
// it just looks broken, and only on someone else's phone.
//
// Verified before writing this: the deployed og:image URL returns
// `content-type: image/svg+xml`.
//
// So the page keeps the SVG and the crawler gets a PNG twin, generated at
// OG card dimensions and committed alongside each SVG. See the repo's
// public/products/ directory -- every *.svg there has a matching *.png,
// an invariant og-image.spec.ts enforces, because a twin that was never
// generated is a 404 the scraper reports as exactly the blank card this
// whole module exists to fix.
//
// To regenerate after adding a category SVG (macOS; `sips` is built in --
// pad colour is the SVG's own background so the fill is seamless):
//
//   cd apps/web/public/products
//   for f in *.svg; do n="${f%.svg}"
//     sips -s format png "$f" --out "/tmp/$n.png" -Z 1200
//     sips -p 630 1200 --padColor F0EEF6 "/tmp/$n.png" --out "$n.png"
//   done

/** The card size every OG consumer sizes its large preview against. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * The crawler-facing twin of a product image URL.
 *
 * Swaps a `.svg` extension for `.png`; anything else is returned unchanged,
 * so a future real product photo (already a JPEG or PNG) passes straight
 * through and a URL with no extension is never mangled.
 *
 * Returns undefined for a missing image so the caller can omit `images`
 * entirely rather than emitting an `og:image` pointing at nothing -- a
 * broken image URL previews worse than no image at all, because the
 * scraper renders an empty frame instead of falling back to a text card.
 */
export function ogImageUrl(imageUrl: string | null | undefined): string | undefined {
  if (!imageUrl) return undefined;

  // Split off any query/fragment before looking at the extension, so
  // `/products/x.svg?v=2` is still recognised as an SVG. Without this the
  // rewrite silently misses and re-emits the unsupported SVG -- the exact
  // bug being fixed, just harder to spot.
  const [path, suffix = ""] = splitSuffix(imageUrl);
  if (!/\.svg$/i.test(path)) return imageUrl; // already a raster; pass through

  // Only rewrite images we actually ship a twin for. Every SVG under
  // MANAGED_PREFIX has a committed PNG (enforced by og-image.spec.ts);
  // an SVG from anywhere else -- a seller upload, a CDN -- has no twin,
  // and pointing at a .png that does not exist would advertise a 404.
  //
  // This module's own rule decides the fallback: a broken image URL
  // previews WORSE than no image, because the scraper renders an empty
  // frame instead of a clean text-only card. So an unmanaged SVG yields
  // undefined and the caller omits og:image entirely.
  //
  // Checked against the NORMALISED path, not the raw string: a prefix test
  // alone accepts `/products/../uploads/logo.svg`, which every consumer
  // then resolves to the unmanaged `/uploads/logo.png` -- the exact
  // nonexistent-PNG this branch exists to prevent, smuggled past the
  // check that was supposed to catch it.
  const clean = normalise(path);
  if (!clean.startsWith(MANAGED_PREFIX)) return undefined;

  // Emit the normalised path, not the raw one, so the URL handed to a
  // scraper is the same path the check was made against.
  return `${clean.replace(/\.svg$/i, ".png")}${suffix}`;
}

/** Product images we ship, and therefore generate PNG twins for. */
const MANAGED_PREFIX = "/products/";

/**
 * Resolves `.` and `..` segments the way a browser or server would, so the
 * managed-prefix check sees the path that will actually be requested
 * rather than the one that was written.
 */
function normalise(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") out.pop();
    else if (segment !== "." && segment !== "") out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** Splits a URL into its path and its `?query#fragment` tail. */
function splitSuffix(url: string): [string, string] {
  const i = url.search(/[?#]/);
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}
