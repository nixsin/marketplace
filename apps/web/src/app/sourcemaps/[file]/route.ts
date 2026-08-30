import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SOURCEMAP_FILENAME,
  SOURCEMAP_SIGNING_KEY_ENV,
  verifySourcemapToken,
} from "@medinstru/config/sourcemap-token";

/**
 * Serves a browser source map to a session holding a valid token, and 404s for
 * everyone else.
 *
 * `productionBrowserSourceMaps: true` stays on because a production stack
 * trace resolving to a real file and line is worth having. What is not worth
 * having is `next start` serving those maps to anyone who asks -- they inline
 * the complete original text of every file, `packages/config` included, which
 * publishes every rate limit and ceiling the app has. `scripts/privatize-
 * sourcemaps.mjs` moves them to `.next/sourcemaps/` (outside the publicly
 * served `.next/static`) and repoints each chunk here.
 *
 * The maps are kept WHOLE rather than stripped of their source: the point of
 * gating is that an authorised session loses nothing.
 *
 * Tokens are signed and self-describing rather than one shared secret -- see
 * packages/config/src/sourcemap-token.js. Mint one with
 * `pnpm --filter web sourcemap:token`.
 */

/** The cookie a whitelisted session carries. */
const COOKIE = "mi_srcmap";

/**
 * Every refusal looks like this.
 *
 * 404 and not 403: a 403 confirms the path exists and something is behind it,
 * which is information an unauthorised caller has no use for. The REASON is
 * logged server-side and never returned -- telling a caller whether their
 * signature was wrong or merely expired hands them a probing oracle.
 */
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
  const key = process.env[SOURCEMAP_SIGNING_KEY_ENV];
  // Unset means source maps are unavailable, not public. A misconfigured
  // deploy must fail toward "no maps" rather than back to the state this
  // route exists to end.
  if (!key) return notFound();

  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  const verified = verifySourcemapToken({ token, key });
  if (!verified.ok) {
    // Logged only when a token was actually presented. Without that guard
    // every crawler hitting the path would fill the log with "no token",
    // burying the entries that mean something -- an expired grant, or a bad
    // signature, which is the one worth noticing.
    if (token) {
      console.warn(
        JSON.stringify({
          msg: "sourcemap access refused",
          reason: verified.reason,
          ...(verified.payload?.iss ? { iss: verified.payload.iss } : {}),
        }),
      );
    }
    return notFound();
  }

  const { file } = await params;
  // The same pattern the build script enforces, shared rather than restated
  // -- two copies disagreed once, and a map the script moved but the route
  // refused would 404 forever with nothing reporting it. Validated rather
  // than merely checked for traversal, since this comes from the URL and
  // indexes a directory inside the deployed image.
  if (!SOURCEMAP_FILENAME.test(file)) return notFound();

  let body: Buffer;
  try {
    body = await readFile(join(process.cwd(), ".next", "sourcemaps", file));
  } catch {
    return notFound();
  }

  // The whole reason the token carries an identity: this line answers "who
  // was reading source maps, and when".
  console.info(
    JSON.stringify({
      msg: "sourcemap served",
      file,
      iss: verified.payload.iss,
      sid: verified.payload.sid,
    }),
  );

  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Never stored by a shared cache: the response is gated on a cookie, and
      // an edge that cached one would serve it to everyone.
      "cache-control": "private, no-store",
    },
  });
}
