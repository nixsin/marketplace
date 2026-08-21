import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals, static files, and /version.
  //
  // The `.*\\..*` clause excludes anything containing a dot, which is why
  // /robots.txt and /sitemap.xml reach their route handlers. /version has
  // no extension, so without naming it here next-intl would treat it as a
  // locale segment, rewrite it to /en/version, and serve a 404 -- a real
  // trap, since the route file would exist and look correct.
  matcher: ["/((?!api|_next|_vercel|version|.*\\..*).*)"],
};
