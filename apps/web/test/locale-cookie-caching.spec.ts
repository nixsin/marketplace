import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProdServer, type StartedServer } from "./helpers/server";
import { DEFAULT_LOCALE, LOCALES } from "@medinstru/config";

/**
 * next-intl must not set `NEXT_LOCALE` on a response a shared cache could
 * store for everyone.
 *
 * This is the invariant the whole Cloudflare HTML caching rule rests on: an
 * edge entry is keyed on the URL, so one visitor's `Set-Cookie` riding along
 * with a cached page hands their language to every later visitor. CLAUDE.md
 * describes the behaviour that makes it safe -- next-intl writes the cookie
 * only when it has something new to say -- but until this file, nothing
 * asserted it, and the safety came from reading a dependency's source by hand
 * on the day it was upgraded. That is exactly the kind of invariant this repo
 * has already learned a human eventually forgets.
 *
 * Driven over real HTTP against the production build, because the property
 * belongs to the middleware as Next actually runs it, not to a function
 * called in isolation.
 *
 * Note the deliberate `Accept-Language` on every request. A bare fetch sends
 * none, which no browser does, and lands on the one path that DOES write a
 * cookie -- so an assertion written without it would test a situation real
 * traffic never produces. CLAUDE.md records that trap; this file is a place
 * it would otherwise be re-learned.
 */
describe("locale cookie vs. shared caching", () => {
  // Optional, and the teardown is guarded on it. An unguarded `server.stop()`
  // throws a TypeError when startup itself failed, replacing the real reason
  // the suite could not run -- most likely a missing production build -- with
  // a message about the harness.
  let server: StartedServer | undefined;

  // The two locales as the app itself defines them, rather than literals:
  // `otherLocale` only has to be a locale the default is not.
  const otherLocale = LOCALES.find((l) => l !== DEFAULT_LOCALE);

  /**
   * A request, with the response asserted to be the page under test before
   * any header is read.
   *
   * Two of the three assertions below are NEGATIVE -- they pass when a header
   * is absent -- and absence is exactly what a 404, a 500 or an unexpected
   * redirect also produces. Without this check a regression that stopped
   * serving the route at all would read as "no cookie set: good". The
   * expected answer is a plain 200 in every case; a locale-prefixed path is
   * already canonical, so next-intl rewrites internally rather than
   * redirecting, and `redirect: "manual"` keeps a future redirect visible
   * here instead of being silently followed to some other response.
   */
  async function getPage(path: string, secFetchDest: string): Promise<Response> {
    const res = await fetch(`${server!.baseUrl}${path}`, {
      headers: {
        "accept-language": `${DEFAULT_LOCALE}-US,${DEFAULT_LOCALE};q=0.9`,
        "sec-fetch-dest": secFetchDest,
      },
      redirect: "manual",
    });

    expect(
      res.status,
      `${path} should serve the page itself; a non-200 would make the ` +
        `cookie assertions below pass for the wrong reason`,
    ).toBe(200);

    return res;
  }

  /** Every `NEXT_LOCALE=` value the response sets, in order. */
  function localeCookieValues(res: Response): string[] {
    return res.headers
      .getSetCookie()
      .map((c) => /^NEXT_LOCALE=([^;]*)/.exec(c)?.[1])
      .filter((v): v is string => v !== undefined);
  }

  beforeAll(async () => {
    expect(
      otherLocale,
      "this suite needs at least two configured locales",
    ).toBeDefined();
    server = await startProdServer(3998);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("sets no cookie when the visitor's own language matches the page", async () => {
    // The common case, and the one that makes edge caching work at all: a
    // browser viewing the locale its Accept-Language implies gets a response
    // with nothing visitor-specific in it, so one request can populate the
    // edge for everyone.
    const res = await getPage(`/${DEFAULT_LOCALE}`, "document");

    expect(localeCookieValues(res)).toEqual([]);
  });

  it("still syncs the cookie on a real navigation that disagrees", async () => {
    // The other half of the contract, asserted so a future version that
    // simply stopped writing the cookie would fail here rather than silently
    // breaking language persistence. A visitor whose browser asks for the
    // default locale but who navigated to the other one has expressed a
    // choice worth remembering.
    //
    // The VALUE is asserted, not just the name. A response setting
    // NEXT_LOCALE to the default locale would satisfy "a cookie was set"
    // while doing the opposite of synchronising -- it would pin the visitor
    // to the language they just navigated away from.
    const res = await getPage(`/${otherLocale!}`, "document");

    expect(localeCookieValues(res)).toEqual([otherLocale]);
  });

  it("sets no cookie on a prefetch or revalidation of that same URL", async () => {
    // Byte-identical to the request above except for Sec-Fetch-Dest, which is
    // the whole point: the router issues these in the background, and a cookie
    // written from one is both uncacheable and wrong -- a revalidation of the
    // locale a user just switched AWAY from would overwrite the locale they
    // had just chosen.
    //
    // This assertion passes on the version before this bump too, which is the
    // reassuring answer rather than a reason to drop it: the guard is not new,
    // and the bump does not touch it. It is here because nothing asserted it
    // and the next bump might.
    //
    // `empty` is what the router sends; anything present and not "document"
    // takes the same path.
    const res = await getPage(`/${otherLocale!}`, "empty");

    expect(localeCookieValues(res)).toEqual([]);
  });
});
