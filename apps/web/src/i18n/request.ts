import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing, TIME_ZONE } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    // Without this, use-intl raises ENVIRONMENT_FALLBACK on every render that
    // formats a date and silently falls back to the *runtime's* zone -- which
    // differs between the server and the viewer's browser, so it is a
    // hydration mismatch waiting for a timestamp near a day boundary. See
    // TIME_ZONE for why UTC specifically.
    timeZone: TIME_ZONE,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
