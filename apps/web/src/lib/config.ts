// Single source of truth for cross-cutting web app configuration --
// values more than one otherwise-unrelated module needs, so there's one
// obvious place to look rather than hunting through whichever business-
// logic file happened to declare something first. An earlier version of
// this fix (PR #83) colocated API_URL inside api.ts and had layout.tsx
// import it from there -- technically correct (one source, no
// duplication) but still meant checking a data-fetching file to find a
// config value nothing about that file's own job would suggest.
// Centralized here instead, imported by anything that needs it.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql";

// This app's own public origin -- needed for generateMetadata's
// metadataBase (OpenGraph image URLs are relative, e.g. seeded product
// imageUrls, and Next.js errors at build time on a relative image URL
// with no metadataBase configured).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// English + Hindi for MVP (TECHNICAL_PLAN.md §14) — additional regional
// languages land in Phase 3, prioritized by where signups concentrate.
// Raw values live here, not in src/i18n/routing.ts, so anything that
// needs "the app's configured locales" (next.config.ts's Cache-Control
// route matcher, in addition to next-intl's own routing setup) can read
// them without pulling in next-intl's defineRouting() wiring just for a
// list of strings.
export const LOCALES = ["en", "hi"] as const;
export const DEFAULT_LOCALE: (typeof LOCALES)[number] = "en";
