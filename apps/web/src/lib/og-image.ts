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

/**
 * The configured blob origin, or "" when storage is not configured.
 * Read at module load -- NEXT_PUBLIC_* is inlined at build time.
 */
const BLOB_BASE_URL = process.env.NEXT_PUBLIC_BLOB_BASE_URL ?? "";

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

  // An absolute URL on OUR OWN blob host is managed, and is now the normal
  // case: once blob storage is configured the API returns
  // `https://images.laxair.shop/products/x.svg` rather than a local path.
  //
  // This was a real, live regression. The "root-relative only" rule below
  // was written when every imageUrl was a local path, and it correctly
  // refused third-party URLs. When the API started returning absolute R2
  // URLs, every product image began looking like someone else's CDN, so
  // og:image was omitted entirely and product pages lost their preview
  // card -- while the home page, which uses a static local path, kept
  // working and hid the problem.
  //
  // Compared by ORIGIN, never by substring: a prefix test would accept
  // `https://images.laxair.shop.evil.example/...`.
  const onBlobHost = isOurBlobHost(path);
  if (!onBlobHost && !path.startsWith("/")) {
    // A genuinely third-party URL. We ship no PNG twin for it, and
    // pointing at one that does not exist advertises a 404.
    return undefined;
  }

  if (onBlobHost) {
    const url = new URL(path);
    // Runs the SAME normalisation as the root-relative branch below, not a
    // raw startsWith on the pathname. Checking the raw form here bypassed
    // it: `/products/%2E%2E%2Fuploads/x.svg` starts with the managed
    // prefix as a string while decoding to `/products/../uploads/x.svg`,
    // outside it. That is precisely the bypass the root-relative branch
    // was already hardened against -- reintroduced by adding a second
    // entry point and not routing it through the same check.
    const segments = normalise(url.pathname);
    if (segments === null) return undefined;

    const clean = `/${segments.join("/")}`;
    if (!clean.startsWith(MANAGED_PREFIX)) return undefined;

    const encoded = segments.map((seg) => encodeURIComponent(seg)).join("/");
    return `${url.origin}/${encoded.replace(/\.svg$/i, ".png")}${suffix}`;
  }

  // Root-relative from here. A relative path like `products/x.svg`
  // resolves against whatever page renders it, so promoting it to
  // `/products/x.png` would silently name a different resource.
  if (!path.startsWith("/")) return undefined;

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
  const segments = normalise(path);
  if (segments === null) return undefined;

  const clean = `/${segments.join("/")}`;
  if (!clean.startsWith(MANAGED_PREFIX)) return undefined;

  // Decoding is used to VALIDATE the path; the URL emitted is re-encoded
  // per segment. Emitting the decoded form directly was a real bug: a
  // percent-encoded delimiter came back as a live one, so
  // `/products/foo%3Fbar.svg` became `/products/foo?bar.png` and a crawler
  // would request `/products/foo` with a query string instead of the
  // intended file. Same for an encoded `#` or space.
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `/${encoded.replace(/\.svg$/i, ".png")}${suffix}`;
}

/** Product images we ship, and therefore generate PNG twins for. */
const MANAGED_PREFIX = "/products/";

/**
 * Whether an absolute URL points at the blob host we control.
 *
 * Origin comparison rather than a prefix test: `startsWith(BLOB_BASE_URL)`
 * would happily accept `https://images.laxair.shop.evil.example/x.svg`,
 * and this decides whether we rewrite a URL that ends up in metadata.
 *
 * Returns false when no blob host is configured, which keeps the
 * not-configured path behaving exactly as before.
 */
function isOurBlobHost(value: string): boolean {
  if (!BLOB_BASE_URL || !URL.canParse(value)) return false;
  try {
    return new URL(value).origin === new URL(BLOB_BASE_URL).origin;
  } catch {
    return false;
  }
}

/**
 * Decodes and resolves `.` and `..` segments the way a browser or server
 * would, so the managed-prefix check sees the path that will actually be
 * requested rather than the one that was written.
 *
 * Returns the decoded SEGMENTS rather than a joined path, so the caller
 * re-encodes each one when building the URL it emits. Returns null when
 * the path cannot be decoded at all.
 */
function normalise(path: string): string[] | null {
  // Split on separators BEFORE decoding, then decode each segment on its
  // own. Order matters: decoding the whole string first turned an ENCODED
  // slash into a real one, so `/products/foo%2Fbar.svg` was split into two
  // segments and emitted as `/products/foo/bar.png`, a different resource
  // entirely. Splitting first keeps `%2F` inside its own segment, where
  // the check below can then refuse it outright.
  //
  // Backslashes are separators for http(s) URLs per the WHATWG parser, so
  // they are folded in before the split -- otherwise `..\uploads` slips
  // past the traversal check.
  //
  // Decoding per segment still catches `%2e%2e`, since that segment decodes
  // to ".." and is compared after decoding.
  //
  // decodeURIComponent throws on a malformed escape (a lone "%"), which
  // must not crash metadata generation: an undecodable path is not one we
  // manage, so returning null (nothing is emitted) is the right failure.
  const out: string[] = [];
  for (const raw of path.replace(/\\/g, "/").split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // A segment whose DECODED form still contains a separator is refused
    // outright. Whether %2F acts as a path separator depends on the server
    // -- WHATWG URL keeps it inside the segment, but plenty of servers
    // decode it first -- and that ambiguity is exactly where a traversal
    // like `..%2fuploads` hides. Every image we manage is a flat filename
    // under /products/, so nothing legitimate is lost by declining rather
    // than guessing which interpretation the origin will apply.
    if (segment.includes("/") || segment.includes("\\")) return null;

    if (segment === "..") out.pop();
    else if (segment !== "." && segment !== "") out.push(segment);
  }
  return out;
}

/** Splits a URL into its path and its `?query#fragment` tail. */
function splitSuffix(url: string): [string, string] {
  const i = url.search(/[?#]/);
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}
