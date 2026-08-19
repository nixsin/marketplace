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
  // Anchored to the very end so a path like `/svg-icons/thing.png` is not
  // rewritten, and case-insensitive because the extension is data, not a
  // constant we control.
  return imageUrl.replace(/\.svg$/i, ".png");
}
