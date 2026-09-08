import { defineRouting } from "next-intl/routing";
import { LOCALES, DEFAULT_LOCALE } from "@medinstru/config";

// The locale list itself lives in @medinstru/config (the single source
// for cross-cutting app config) -- this just wires it into next-intl's
// own routing setup.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
});

export type Locale = (typeof routing.locales)[number];

/**
 * The one time zone every rendered date is formatted in.
 *
 * UTC is not a placeholder for "we haven't picked the real one yet" -- it is
 * the choice that makes server and client agree. Every date in this app is
 * rendered inside a "use client" component, so the string produced during SSR
 * (in the server's zone, UTC on Render) has to match byte-for-byte what the
 * browser recomputes during hydration (in the viewer's zone). A timestamp
 * near a day boundary -- 23:37 UTC -- genuinely lands on a different calendar
 * date in IST, and React reports that as a hydration mismatch.
 *
 * It trades "shows the viewer's local date" for "shows a stable, correct
 * date", which is the right trade for a last-updated indicator and would NOT
 * be for something like a delivery slot or an appointment time. Revisit it
 * per-value if such a thing is ever added, rather than changing this default.
 *
 * Declared here so both halves of the app read the same value: next-intl's
 * server config (i18n/request.ts) and the client provider (LocaleProvider).
 * Setting only one of them is what produced use-intl's ENVIRONMENT_FALLBACK
 * on every build -- "The `timeZone` parameter wasn't provided and there is no
 * global default configured. Consider adding a global default to avoid markup
 * mismatches caused by environment differences."
 */
export const TIME_ZONE = "UTC";
