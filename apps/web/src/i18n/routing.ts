import { defineRouting } from "next-intl/routing";

// English + Hindi for MVP (TECHNICAL_PLAN.md §14) — additional regional
// languages land in Phase 3, prioritized by where signups concentrate.
export const routing = defineRouting({
  locales: ["en", "hi"],
  defaultLocale: "en",
});

export type Locale = (typeof routing.locales)[number];
