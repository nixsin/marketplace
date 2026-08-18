# Localization

English + Hindi, per TECHNICAL_PLAN.md §14 — path-based routing (`/en`, `/hi`) via `next-intl`, resolved by the proxy/middleware in this priority order: **URL path prefix first** (if present, wins outright) → **`Accept-Language` header negotiation** (first visit only) → **`NEXT_LOCALE` cookie** (returning visits, set automatically once a locale is resolved). Verified directly with real requests, not just asserted from docs — see the git history for the curl checks.

- `apps/web/src/i18n/` — routing config, request config, locale-aware `Link`/`useRouter` (`@/i18n/navigation`, not `next/link` — using the plain Next one anywhere under `[locale]` loses the current locale on navigation).
- `apps/web/messages/{en,hi}.json` — UI chrome strings only.
- **Product/seller content (name, description, category) is never auto-translated** — it stays in whatever language the seller entered it in. Only platform-owned UI text (nav, buttons, labels) is translated. This is a deliberate §14 rule, not a gap: machine-translating a device's intended-use description is a liability for a medical-instruments marketplace, not a convenience.

## Switching language

**Instant and client-side** (`apps/web/src/components/locale-provider.tsx`) — no server round trip, no route navigation. Swapping `NextIntlClientProvider`'s `messages` prop re-renders every `useTranslations()` consumer immediately; the URL updates via `history.replaceState` (cosmetic, fires no request) rather than `next-intl`'s router, which would re-fetch the `[locale]` route segment from the server on every switch. A locale's messages are fetched at most once per session — an explicit `Map` cache (seeded with the initial server-resolved locale) means switching en→hi→en→hi only ever touches the network on the very first visit to a given language; every switch after that, in either direction, is zero requests. Verified with real network monitoring, not assumed.

This did require converting Header/Footer/Pagination/ProductCard from Server Components to Client Components (they need to react to client-side locale state) — a real, measured bundle-size cost, raised twice and documented both times in `apps/web/test/bundle-budget.spec.ts` rather than silently absorbed: 150KB → 160KB → 172KB.
