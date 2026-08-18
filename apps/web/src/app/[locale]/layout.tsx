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
// prioritizing (see CLAUDE.md's caching/CDN plan). Same fallback URL
// api.ts itself uses, so this never points at a different origin than
// the fetch that actually follows it.
const API_ORIGIN = new URL(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql",
).origin;

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
        <link rel="preconnect" href={API_ORIGIN} />
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
