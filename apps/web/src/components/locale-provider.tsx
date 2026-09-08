"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { NextIntlClientProvider } from "next-intl";
import { TIME_ZONE, type Locale } from "@/i18n/routing";

type Messages = Record<string, unknown>;

interface LocaleContextValue {
  locale: Locale;
  isSwitching: boolean;
  switchLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function updateUrl(current: Locale, next: Locale) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(
    new RegExp(`^/${current}(?=/|$)`),
    `/${next}`,
  );
  window.history.replaceState(window.history.state, "", url);
  document.documentElement.lang = next;
}

export function useLocaleSwitcher() {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocaleSwitcher must be used within LocaleProvider");
  }
  return ctx;
}

// Client-side locale switching: the initial locale/messages come from the
// server (matching whatever the middleware resolved — path prefix or
// Accept-Language), but switching *afterward* never hits the server again.
// Swapping NextIntlClientProvider's messages prop re-renders every
// useTranslations() consumer with the new strings immediately — the same
// mechanism Next.js uses for any client state update, not a route change.
//
// The URL is still updated (via history.replaceState, not router.replace)
// so the address bar and deep-linking/SEO stay correct — that update is
// cosmetic and fires no request, unlike Next's router navigation which
// re-fetches the [locale] route segment from the server.
export function LocaleProvider({
  initialLocale,
  initialMessages,
  children,
}: {
  initialLocale: Locale;
  initialMessages: Messages;
  children: React.ReactNode;
}) {
  const [locale, setLocale] = useState(initialLocale);
  const [messages, setMessages] = useState(initialMessages);
  const [isPending, startTransition] = useTransition();

  // Explicit cache, not just relying on the JS module loader's incidental
  // dedup of dynamic import() chunks — this makes "switch back to a
  // previously-loaded language costs nothing" a guarantee we own and can
  // test, not an implementation detail of the bundler. Seeded with the
  // initial (server-resolved) locale so switching away and back to it
  // never re-imports something we already have in hand.
  const messageCache = useRef<Map<Locale, Messages>>(
    new Map([[initialLocale, initialMessages]]),
  );

  const switchLocale = useCallback(
    (next: Locale) => {
      if (next === locale) return;

      const cached = messageCache.current.get(next);
      if (cached) {
        setLocale(next);
        setMessages(cached);
        updateUrl(locale, next);
        return;
      }

      startTransition(async () => {
        const nextMessages = (await import(`../../messages/${next}.json`))
          .default as Messages;

        messageCache.current.set(next, nextMessages);
        setLocale(next);
        setMessages(nextMessages);
        updateUrl(locale, next);
      });
    },
    [locale],
  );

  const value = useMemo(
    () => ({ locale, isSwitching: isPending, switchLocale }),
    [locale, isPending, switchLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      {/*
        timeZone is passed explicitly, and forgetting it is what produced
        use-intl's ENVIRONMENT_FALLBACK on every build. This provider is
        constructed by hand rather than inherited from the server's config,
        so anything the server resolves and this does not name is simply
        dropped -- silently, with the client falling back to the *browser's*
        zone while the server used its own. See TIME_ZONE in i18n/routing.ts.
      */}
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone={TIME_ZONE}
      >
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
