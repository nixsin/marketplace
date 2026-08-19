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
