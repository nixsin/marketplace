/**
 * apps/web's REQUIRED runtime values.
 *
 * Separate from the package's main entry on purpose. These throw when unset,
 * and the main entry is imported by six Node scripts that never read them --
 * including scripts/ai-code-review-precheck.mjs, which runs on every
 * `git push`. Evaluating a throwing constant there would block pushes over a
 * variable the script has no use for.
 *
 * Same reasoning that put sourcemap-token behind its own subpath.
 */

/**
 * Resolve a required public URL. THERE IS NO DEFAULT.
 *
 * This used to fall back to a localhost value whenever the variable was
 * missing, and that fallback was the single worst configuration failure this
 * app had. A web service deployed without NEXT_PUBLIC_SITE_URL served
 * canonical URLs, hreflang alternates and OpenGraph images pointing at
 * `http://localhost:3000` -- to real crawlers, with every page still
 * returning 200 and nothing failing anywhere. NEXT_PUBLIC_API_URL is the same
 * shape and worse: the visitor's own browser is told to fetch products from
 * the visitor's own machine, and the value also derives the CSP's
 * connect-src, so it misdirects and blocks at once.
 *
 * A default cannot distinguish "the developer has not configured this yet"
 * from "production lost this variable". Removing it makes both loud, and the
 * first case is a one-line fix (`cp .env.example .env`) while the second was
 * previously invisible.
 *
 * A LOCALHOST VALUE IS ALSO REJECTED ON RENDER, not just a missing one, and
 * that is the half that actually bites. Before this change
 * `apps/web/Dockerfile` declared
 * `ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`, so a build that
 * failed to pass the value produced a populated, plausible, wrong variable
 * rather than an empty one. Those ARG defaults are gone too, but the check
 * stays: a wrong value can arrive from anywhere, and absence is only one of
 * the ways this goes wrong.
 *
 * WHERE THIS THROWS: everywhere, at import. `next.config.ts` imports this
 * package and Next loads that file at container BOOT as well as at build, so
 * a misconfigured deploy fails to boot, Render marks it failed, and the
 * previous healthy version stays live. That is strictly better than answering
 * 200 with localhost links.
 */
function requirePublicUrl(name, value) {
  if (!value) {
    throw new Error(
      `${name} is not set. There is no default -- a localhost fallback here ` +
        `publishes localhost links to real visitors, so absence has to be loud. ` +
        `Locally: copy apps/web/.env.example to apps/web/.env. On Render: set it ` +
        `on the service AND pass it as a Docker build arg, because NEXT_PUBLIC_* ` +
        `values are inlined into the client bundle at build time.`,
    );
  }

  let hostname;
  try {
    ({ hostname } = new URL(value));
  } catch {
    throw new Error(
      `${name} is not a valid URL. Found: ${JSON.stringify(value)}`,
    );
  }

  // Only a problem in production -- it is the correct value on a laptop.
  // TWO SIGNALS, because a Docker deploy on Render splits into a build and a
  // runtime that see different environments: `RENDER=true` reaches the running
  // container, while `RENDER_GIT_COMMIT` is passed into the image build via an
  // explicit ARG (Render hands a Docker build nothing else). Checking both
  // catches a bad value at build -- while it can still be fixed before being
  // inlined into the bundle -- and again at every boot.
  //
  // Neither is inlined into the client bundle (only NEXT_PUBLIC_* are), so
  // this is false in the browser and the browser never throws; it receives
  // whatever the server already validated.
  const onRender =
    process.env.RENDER === "true" || Boolean(process.env.RENDER_GIT_COMMIT);

  if (onRender && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new Error(
      `${name} points at ${hostname} while running on Render. Every visitor ` +
        `would resolve that to their own machine. The thorough version of this ` +
        `check -- private ranges, CGNAT, IPv4-mapped IPv6, embedded credentials ` +
        `-- lives in apps/web/src/lib/site-url.ts and runs from next.config.ts.`,
    );
  }

  return value;
}

export const API_URL = requirePublicUrl(
  "NEXT_PUBLIC_API_URL",
  process.env.NEXT_PUBLIC_API_URL,
);

// Used as `metadataBase` and for absolute OpenGraph image URLs. Next
// requires this once any route uses a relative OG image path.
export const SITE_URL = requirePublicUrl(
  "NEXT_PUBLIC_SITE_URL",
  process.env.NEXT_PUBLIC_SITE_URL,
);
