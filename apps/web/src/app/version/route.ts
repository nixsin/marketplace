import { NextResponse } from "next/server";
import { API_URL, BUILD_COMMIT, BUILD_TIME, SITE_URL } from "@medinstru/config";

// Build identity as JSON, for answering "what is actually deployed right
// now?" without parsing response headers.
//
// The same commit is already exposed as the x-build-commit header and a
// <meta> tag, so this adds no information the page didn't carry -- what it
// adds is that a human or a script can read it in one request, and that it
// carries the two BUILD-TIME values that have each caused a real incident:
//
//   apiUrl   NEXT_PUBLIC_API_URL is inlined at build time. When the API
//            moved to api.laxair.shop, the variable was set in the Render
//            dashboard and both services restarted -- but a restart reuses
//            the existing image, so the deployed bundle still called the
//            old host. Diagnosing that meant grepping the served JS chunks.
//            This endpoint answers it directly.
//
//   siteUrl  NEXT_PUBLIC_SITE_URL shipped unset once, so every WhatsApp
//            share link and og:image pointed at http://localhost:3000.
//            A build guard now refuses to build without it, but seeing the
//            live value is still the fastest confirmation.
//
// Nothing here is secret. All four values are already public: the commit is
// in a response header, apiUrl is in the CSP's connect-src and the client
// bundle, and siteUrl is in every canonical tag.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      commit: BUILD_COMMIT,
      buildTime: BUILD_TIME,
      apiUrl: API_URL,
      siteUrl: SITE_URL,
      // Proves the response is fresh rather than served from some cache,
      // which matters because a stale answer here is worse than no answer:
      // it would assert that an old build is current.
      servedAt: new Date().toISOString(),
    },
    {
      headers: {
        // Never cacheable, at any layer. A deploy-identity endpoint that
        // can be cached will eventually report a build that is no longer
        // running -- exactly the confusion it exists to remove.
        "Cache-Control": "no-store, must-revalidate",
      },
    },
  );
}
