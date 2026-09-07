import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals, static files, and sitemap shards.
  //
  // `sitemaps/` is the non-obvious one, and leaving it out broke the entire
  // product sitemap in production. Everything else here is excluded because
  // it must not be localised; `/sitemaps/<id>` is excluded because it is not
  // a page at all -- it lives at app/sitemaps/[id]/route.ts, OUTSIDE
  // [locale]. Without this entry next-intl saw a dotless path, treated it as
  // locale-negotiable, and answered `/sitemaps/0` with a 307 to
  // `/en/sitemaps/0` -- a route that does not exist, so every shard 404'd
  // and no product URL ever reached a crawler.
  //
  // `/sitemap.xml` was fine the whole time and that is what hid this: it
  // contains a dot, so `.*\..*` already excluded it. The index it produced
  // returned 200 while every link inside it was dead, which is the shape of
  // failure worth remembering -- the entry point looked healthy.
  //
  // Written `sitemaps/` with the slash, not bare `sitemaps`: the lookahead
  // matches a prefix, so the bare form would also swallow a future
  // `/sitemapsomething`.
  matcher: ["/((?!api|_next|_vercel|sitemaps/|.*\\..*).*)"],
};
