import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { Geist, Geist_Mono } from "next/font/google";
import { routing, type Locale } from "@/i18n/routing";
import { LocaleProvider } from "@/components/locale-provider";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { PageViewTracker } from "@/components/page-view-tracker";
import { API_URL, BUILD_COMMIT, BUILD_TIME, SITE_URL } from "@medinstru/config";
import "../globals.css";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "@/lib/og-image";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The product-data fetch (src/lib/api.ts) is the first request to a
// *second* origin -- DNS+TCP+TLS for it doesn't start until client JS
// executes and calls fetch(), today. Preconnecting lets the browser open
// that connection in parallel with CSS/JS loading instead of after,
// which matters most on the high-latency connections this app is
// prioritizing (see CLAUDE.md's caching/CDN plan). Imports API_URL from
// the shared @medinstru/config (rather than re-reading
// NEXT_PUBLIC_API_URL and re-declaring its fallback here) so this can
// never point at a different origin than the fetch that actually follows
// it -- two independent copies of the same fallback literal previously
// could (and, per a real PR review comment, did prompt the question)
// silently drift apart.
//
// The link below sets crossOrigin="anonymous" to match: browsers keep a
// separate connection pool per origin for anonymous-CORS vs. same-origin/
// no-CORS requests, so a preconnect without a matching crossorigin mode
// opens a connection in the wrong pool and can't be reused by the actual
// fetch that follows -- an AI review caught this (2026-08-18). "anonymous"
// specifically, not "use-credentials", because fetchProductsPaged sets
// credentials: "omit" on its real request.
//
// new URL() requires an absolute URL -- API_URL has no guarantee of that
// (a relative value like "/graphql" would throw TypeError: Invalid URL).
// Caught by an AI review: unlike a client-side fetch() call, this runs at
// module load, which for a layout happens during Next's static
// generation -- an invalid value here would crash every page's build,
// not just one API call. A relative/same-origin value also has no
// separate origin worth preconnecting to in the first place, so skipping
// the hint entirely is the correct behavior here, not just a defensive
// workaround.
function getApiOrigin(): string | null {
  try {
    return new URL(API_URL).origin;
  } catch {
    return null;
  }
}
const API_ORIGIN = getApiOrigin();

// metadataBase is required, not optional, once any route uses a relative
// OpenGraph image URL (the product-details page does -- seeded imageUrls
// are relative paths like "/products/diagnostic-imaging.svg"). Next.js
// errors at build time on a relative image URL with no metadataBase
// configured. Guarded the same defensively as getApiOrigin() above: a
// throw here would break metadata for every route, not just the one that
// actually needs it.
function getSiteUrl(): URL | undefined {
  try {
    return new URL(SITE_URL);
  } catch {
    return undefined;
  }
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("title"),
    description: t("description"),
    metadataBase: getSiteUrl(),
    // Without these, sharing the site's own URL produces a bare link with
    // no preview card at all. Only the product page had OpenGraph tags, so
    // the one link most likely to be shared -- the home page -- was the one
    // that previewed as nothing. Set on the LAYOUT so every route inherits
    // a sensible card; the product page overrides with its own.
    openGraph: {
      type: "website",
      siteName: "MedInstru Market",
      title: t("title"),
      description: t("description"),
      locale,
      // A dedicated 1200x630 PNG, not an SVG: Facebook's scraper (which
      // WhatsApp shares) cannot render SVG and shows an empty frame.
      images: [
        {
          url: "/home-og.png",
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: t("title"),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("description"),
      images: ["/home-og.png"],
    },
    // Baked into every page so the running build is readable with a plain
    // curl -- see @medinstru/config's BUILD_COMMIT for the deploy-skew
    // incident this exists to make visible. `other` is Next's escape hatch
    // for arbitrary <meta> tags.
    other: {
      "build-commit": BUILD_COMMIT,
      "build-time": BUILD_TIME,
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Enables static rendering for this locale (next-intl needs to know the
  // active locale before any translation calls happen in this render).
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {API_ORIGIN !== null && (
          <link rel="preconnect" href={API_ORIGIN} crossOrigin="anonymous" />
        )}
      </head>
      <body className="min-h-full flex flex-col">
        <LocaleProvider initialLocale={locale as Locale} initialMessages={messages}>
          <ServiceWorkerRegistration />
          <PageViewTracker />
          <Header />
          <main className="flex flex-1 flex-col">{children}</main>
          <Footer />
        </LocaleProvider>
      </body>
    </html>
  );
}
