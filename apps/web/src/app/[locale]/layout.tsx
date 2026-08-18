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
import { API_URL } from "@/lib/config";
import "../globals.css";

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
// the shared src/lib/config.ts (rather than re-reading
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
  return { title: t("title"), description: t("description") };
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
          <Header />
          <main className="flex flex-1 flex-col">{children}</main>
          <Footer />
        </LocaleProvider>
      </body>
    </html>
  );
}
