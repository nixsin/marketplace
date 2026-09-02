/**
 * apps/web's REQUIRED runtime values.
 *
 * Behind their own subpath because they THROW when unset on a deployment, and
 * the package's main entry is imported by six Node scripts and by
 * apps/api/src/main.ts -- none of which read these. Evaluating a throwing
 * constant there crashed a production API boot for a variable the API does
 * not use.
 *
 * Same reasoning that put sourcemap-token behind its own subpath: the main
 * entry must stay safe to import from anywhere.
 */

import { isPublicDnsName } from "./dns-name.js";

/**
 * Resolve a public URL that has a localhost development default.
 *
 * THE DEFAULT IS NOT A FALLBACK ON RENDER -- there it throws.
 *
 * The default is correct for local dev, for CI (`test-web` runs `pnpm build`
 * with no environment at all) and for `docker-web-prod-boot` (which boots the
 * real production image with no configuration, on purpose). It is NEVER
 * correct in production, and applying it there silently is the single worst
 * configuration failure this app has: a web service that lost
 * NEXT_PUBLIC_SITE_URL serves canonical URLs, hreflang alternates and
 * OpenGraph images pointing at `http://localhost:3000` -- to real crawlers,
 * with every page still returning 200 and nothing failing anywhere.
 * NEXT_PUBLIC_API_URL is the same shape and worse: the visitor's own browser
 * is told to fetch products from the visitor's own machine, and the value
 * also derives the CSP's connect-src, so it misdirects and blocks at once.
 *
 * A LOCALHOST VALUE IS REJECTED, not just a missing one, and that is the half
 * that actually bites. `apps/web/Dockerfile` declares
 * `ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql`, so a Render build
 * that fails to pass the value does not produce an EMPTY variable -- it
 * produces a populated, plausible, wrong one. Checking only for absence would
 * miss every real occurrence of this.
 *
 * Throwing here means a misconfigured deploy FAILS TO BOOT rather than
 * serving a broken site: Next loads next.config.ts at container start (not
 * only at build), so this runs on every production boot, the deploy is marked
 * failed, and Render keeps the previous healthy version live. That is a
 * strictly better outcome than answering 200 with localhost links.
 *
 * Deliberately keyed on RENDER rather than NODE_ENV=production: the prod
 * image sets NODE_ENV=production wherever it is built, including in the CI
 * boot test that must keep passing with no configuration.
 */
function resolvePublicUrl(name, value, devDefault) {
  // SERVER ONLY, and this is not a shortcut -- it is where the check belongs.
  //
  // NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, and
  // the build runs this same function on the server first. So by the time a
  // browser evaluates this, the value has already been validated and frozen;
  // re-checking it there can only ever agree. Worse, the browser cannot act on
  // any of these messages -- "set it as a Docker build arg" is advice for a
  // deploy, not for a visitor.
  //
  // The cost was measured, not assumed: with the checks running in the client
  // bundle the error prose shipped to every visitor and pushed JS transfer to
  // 196.3KB against a 196KB budget, failing the perf gate on its one
  // deterministic metric. `typeof window` is dead-code-eliminated in the
  // client build, so the strings go with it.
  // Returns the RESOLVED value, not the raw one. An early `return value` here
  // was wrong twice over: it skipped the default as well as the validation, so
  // any environment where `window` exists but the value was never inlined --
  // jsdom under vitest, most obviously -- got `undefined` and threw
  // `Invalid URL` somewhere far away. Caught by product-detail.spec.tsx.
  if (typeof window !== "undefined") return value || devDefault;

  // TWO SIGNALS, because a Docker deploy on Render splits into a build and a
  // runtime that see different environments. `RENDER=true` reaches the
  // running container; `RENDER_GIT_COMMIT` is passed into the image build via
  // an explicit ARG (Render hands a Docker build nothing else). Checking both
  // means a bad value is caught at build -- while it can still be fixed
  // before being inlined into the bundle -- and again at every boot.
  //
  // Neither is inlined into the client bundle (only NEXT_PUBLIC_* are), so
  // this is false in the browser and the browser never throws; it receives
  // whatever the server already validated.
  const onRender =
    process.env.RENDER === "true" || Boolean(process.env.RENDER_GIT_COMMIT);
  if (!onRender) return value || devDefault;

  if (!value) {
    throw new Error(
      `${name} is not set, and this process is running on Render. ` +
        `Refusing to fall back to ${devDefault}: that would publish localhost ` +
        `links to real visitors and crawlers. Set it on the Render service ` +
        `AND pass it as a Docker build arg -- NEXT_PUBLIC_* values are inlined ` +
        `into the client bundle at build time.`,
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    // NAMES THE VARIABLE, NEVER ECHOES THE VALUE.
    //
    // This threw `Found: ${value}`, and a malformed URL is exactly the shape
    // that carries a pasted credential -- `https://user:secret@` fails to
    // parse, so it took this path and the secret landed in a deploy log. The
    // redaction in env-contract.js does not help here: this throws during
    // module evaluation, long before any check runs.
    throw new Error(
      `${name} is not a valid URL. Its value is not shown, because a malformed ` +
        `URL is the shape most likely to carry a pasted credential.`,
    );
  }

  // A COARSE last line of defence, deliberately. The thorough version --
  // private ranges, CGNAT, IPv4-mapped IPv6, embedded credentials, trailing
  // dots -- lives in apps/web/src/lib/site-url.ts and runs from
  // next.config.ts, where it can produce a much better message. This exists
  // so the value is still checked on any path that reaches the config without
  // going through next.config.ts, and covers the case that actually happens:
  // the Dockerfile ARG default surviving because the build arg was not passed.
  // A HOSTNAME CHECK ALONE IS NOT ENOUGH, and this is the path that has to
  // catch it: next.config.ts's richer guard covers the boot it runs on, but
  // this module exists for every OTHER import path.
  //
  // `file:///x` and `javascript:...` have hostnames nothing would flag, and
  // `https://user:secret@example.com/graphql` is a perfectly ordinary URL
  // whose credentials would then be INLINED INTO THE CLIENT BUNDLE, since
  // NEXT_PUBLIC_* values are baked in at build time and shipped to every
  // visitor. Neither is reachable through the hostname list below.
  // HTTPS ONLY on a deployment, not "http or https". The site sends HSTS with
  // a two-year max-age, so a plain-http origin is unreachable for every
  // returning visitor -- and this branch only runs on a deployment, where
  // there is no reason to allow it.
  if (parsed.protocol !== "https:") {
    // THE PROTOCOL IS NOT ECHOED EITHER, which looks over-careful and is
    // not: a mistakenly pasted secret shaped like `hunter2:abc` is a valid
    // URL whose protocol IS `hunter2:`, so printing the scheme prints the
    // first half of the secret. Nothing derived from the value is safe to
    // show once the value might not be a URL at all.
    throw new Error(
      `${name} must be an https:// URL in production — HSTS is served with a ` +
        `two-year max-age, so a plain-http origin is unreachable for every ` +
        `returning visitor. (Value not shown: a mistyped value can itself be ` +
        `a secret.)`,
    );
  }

  if (parsed.username || parsed.password) {
    // Never echoed: this is a credential, and NEXT_PUBLIC_* reaches the
    // browser, so the value is about to be far more public than this log.
    throw new Error(
      `${name} embeds credentials in its URL. NEXT_PUBLIC_* values are inlined ` +
        `into the client bundle, so this would ship them to every visitor. ` +
        `(Value not shown.)`,
    );
  }

  // MUST BE A PUBLIC DNS NAME -- see dns-name.js for why this is not an
  // IP-range check. In production this value is always a name: an IP literal
  // cannot get a certificate from the CDN in front of it, and the scheme
  // check above already requires https. The incident this guard exists for
  // was `http://localhost:3000`, a hostname rather than an address.
  if (!isPublicDnsName(parsed.hostname)) {

    throw new Error(
      `${name} must be a public DNS name in production — got a bare host with ` +
        `no domain, or an IP literal. Visitors reach this over the CDN, which ` +
        `needs a name it holds a certificate for. (Value not shown: a mistyped ` +
        `value can itself be a secret.)`,
    );
  }

  return value;
}

export const API_URL = resolvePublicUrl(
  "NEXT_PUBLIC_API_URL",
  process.env.NEXT_PUBLIC_API_URL,
  "http://localhost:4000/graphql",
);

// Used as `metadataBase` and for absolute OpenGraph image URLs. Next
// requires this once any route uses a relative OG image path.
export const SITE_URL = resolvePublicUrl(
  "NEXT_PUBLIC_SITE_URL",
  process.env.NEXT_PUBLIC_SITE_URL,
  "http://localhost:3000",
);
