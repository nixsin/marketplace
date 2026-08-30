import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

/**
 * Serves a browser source map to a session that holds the access token, and
 * 404s for everyone else.
 *
 * `productionBrowserSourceMaps: true` stays on because a production stack
 * trace resolving to a real file and line is worth having. What is not worth
 * having is `next start` serving those maps to anyone who asks -- they inline
 * the complete original text of every file, `packages/config` included, which
 * publishes every rate limit and ceiling the app has. `scripts/privatize-
 * sourcemaps.mjs` moves them to `.next/sourcemaps/` (outside the publicly
 * served `.next/static`) and repoints each chunk here.
 *
 * The maps are kept WHOLE rather than stripped of their source, because the
 * point of gating is that an authorised session loses nothing.
 *
 * To use: set SOURCEMAP_ACCESS_TOKEN on the service, then in the browser
 * console on the site's own origin:
 *
 *     document.cookie = "mi_srcmap=<token>; path=/; SameSite=Strict; Secure"
 *
 * A cookie rather than a query parameter or header on purpose. Devtools
 * fetches maps itself and cannot be made to send a custom header, and a token
 * in a URL ends up in access logs, referrers and shell history.
 */

/** The cookie a whitelisted session carries. */
const COOKIE = "mi_srcmap";

/**
 * Name only, never a value -- the package is committed and a literal would
 * enter git history permanently. Same rule the shared config follows for
 * every other credential.
 */
const TOKEN_ENV = "SOURCEMAP_ACCESS_TOKEN";

/**
 * Only the shapes `next build` actually emits. Anything else is refused
 * before it can reach the filesystem -- this value comes from the URL, and
 * the directory it indexes is inside the deployed image.
 */
const SAFE_NAME = /^[A-Za-z0-9_-]+\.(?:js|css)\.map$/;

/**
 * Constant-time comparison that does not leak length.
 *
 * `timingSafeEqual` throws on mismatched lengths, which would turn a length
 * difference into an observable exception. Both sides are hashed to a fixed
 * width first, so every comparison costs the same regardless of input.
 */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const digest = async (value: string) =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return timingSafeEqual(await digest(presented), await digest(expected));
}

/** Indistinguishable from a missing route, deliberately. */
function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const expected = process.env[TOKEN_ENV];
  // Unset means source maps are simply unavailable. Fail closed: a
  // misconfigured deploy must not fall back to serving them publicly, which
  // is the exact state this route exists to end.
  if (!expected) return notFound();

  const presented = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  if (!presented || !(await tokenMatches(presented, expected))) return notFound();

  const { file } = await params;
  if (!SAFE_NAME.test(file)) return notFound();

  let body: Buffer;
  try {
    body = await readFile(join(process.cwd(), ".next", "sourcemaps", file));
  } catch {
    return notFound();
  }

  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Never stored by a shared cache: the response is gated on a cookie, and
      // an edge that cached one would serve it to everyone.
      "cache-control": "private, no-store",
    },
  });
}
