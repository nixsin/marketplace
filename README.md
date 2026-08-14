# MedInstru Market

B2B marketplace for medical & surgical instruments. Full architecture, rationale, and roadmap live in [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) — read that first.

## Repo layout

```
apps/
  web/   Next.js (App Router, TypeScript, Tailwind, shadcn/ui)
  api/   NestJS (GraphQL via Apollo, Prisma ORM, Postgres)
packages/  shared code (empty for now — Phase 1+)
docker-compose.yml   local Postgres + Redis (optional — see below)
```

This is a pnpm workspace monorepo (see `pnpm-workspace.yaml`), not two independent projects.

## Prerequisites

- Node.js 22+ (installed here via [nvm](https://github.com/nvm-sh/nvm))
- pnpm (via `corepack enable`)
- Postgres + Redis — this machine is set up via **Homebrew** (`postgresql@16`, `redis`, both running as `brew services`). `docker-compose.yml` is also in the repo as an alternative if you'd rather containerize later — either works, `.env` just needs to point at whichever is running.

### This machine's local setup (already done)

- `brew services start postgresql@16 redis`
- A `postgres` superuser role (password `postgres`) was created to match `docker-compose.yml`'s credentials, so `.env` doesn't need to change if you switch to Docker later: `psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"`
- Homebrew's `redis.conf` ships with `loadmodule` lines for Bloom/Search/JSON/Timeseries modules that aren't actually bundled with the formula — they were commented out in `/opt/homebrew/etc/redis.conf` (Redis was crash-looping on startup otherwise). Not needed for anything in this stack (plain caching/queues only).

## First-time setup

```bash
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

createdb medinstru   # skip if already created

# apply the Phase 0 schema (Organization, User, License — see TECHNICAL_PLAN.md §6)
pnpm --filter api exec prisma migrate dev --name init
```

## Running locally

```bash
pnpm dev:web   # http://localhost:3000
pnpm dev:api   # http://localhost:4000/graphql (GraphQL Playground in dev)
```

## What's scaffolded so far (Phase 0)

- Monorepo workspace (pnpm) with `apps/web` and `apps/api`.
- `apps/web`: Next.js + Tailwind + shadcn/ui (Radix base) initialized, base components added (button, input, table, dialog, card, badge, sonner) + react-hook-form/zod for forms.
- `apps/api`: NestJS + GraphQL (code-first, auto-generated schema at `apps/api/src/schema.gql`) + Prisma.
- Phase 0 data model: `Organization`, `User`, `License` (see `apps/api/prisma/schema.prisma`, mirrors TECHNICAL_PLAN.md §6).
- Auth flow: phone OTP request/verify → JWT, plus a `completeOnboarding` mutation that creates an Organization + first User together. **SMS sending is a dev-only stub** (`apps/api/src/auth/sms.service.ts` logs the OTP instead of sending it — no MSG91/Gupshup account wired up yet, see TODO in that file). OTP storage is in-memory (`otp-store.service.ts`) — needs to move to Redis before this runs on more than one process (TODO noted in file).
- Verified end-to-end against a real local Postgres: `requestOtp` → `verifyOtp` → `completeOnboarding` correctly creates and persists an `Organization` + `User` row.
- A minimal `Product` model (name, brand, category, deviceClass, certifications, location, seller relation) was added early — ahead of the rest of the Phase 1 catalog — to get one real item flowing end-to-end: seeded via `apps/api/prisma/seed.ts` (`pnpm --filter api exec prisma db seed`), exposed via a `products` GraphQL query, and rendered on `apps/web`'s home page (`getProducts()` in `apps/web/src/lib/api.ts` → `ProductCard`). This is not the full Phase 1 catalog (no bulk upload, no category taxonomy, no search) — just proof that DB → API → UI is wired correctly.

## Testing

```bash
pnpm --filter api test        # unit tests (fast, mocked dependencies)
pnpm --filter api test:cov    # unit tests with coverage report
pnpm --filter api test:e2e    # integration tests — real GraphQL + real Postgres
```

- **Unit tests** (`apps/api/src/**/*.spec.ts`) cover the actual business logic with dependencies mocked: `otp-store.service.spec.ts` (expiry, single-use, per-phone scoping), `auth.service.spec.ts` (OTP verification branches, JWT issuance, onboarding-token validation), `organizations.service.spec.ts`.
- **Integration tests** (`apps/api/test/auth.e2e-spec.ts`) boot the real Nest app and hit `/graphql` over HTTP with `supertest`, against a **separate real Postgres database** (`medinstru_test`, not `medinstru`) — request OTP → verify → complete onboarding, checking both the GraphQL response and the actual rows written to the DB, plus the error paths (wrong code, garbage onboarding token, invalid phone format). Tables are truncated between tests for isolation. The only thing mocked is `SmsService` (swapped for a test double that captures the OTP instead of logging it) — everything else, including validation pipes and Prisma, runs for real.
- First-time setup for the test DB (already done on this machine, only needed once per environment):
  ```bash
  createdb medinstru_test
  pnpm --filter api test:e2e:migrate
  ```
- Prisma 7's client uses a WASM query compiler that needs Node's `--experimental-vm-modules` flag under Jest — already baked into the `test:e2e` script, not something you need to pass yourself.
- `products.service.spec.ts` covers cursor-pagination correctness (limit respected, cursor continuity, `nextCursor` undefined on the last page). `test/products.e2e-spec.ts` automates the same pagination behavior end-to-end against real Postgres — two pages, no duplicates, correct termination, seller relation resolved.

### Performance tests (automate the checks from TECHNICAL_PLAN.md §12)

```bash
pnpm --filter web build && pnpm --filter web test   # static caching + JS bundle budget
pnpm --filter web test:perf                          # Lighthouse audit vs. §12A targets (manual/periodic, not CI-gated)
pnpm --filter api test:load                           # autocannon load test (manual/periodic, not CI-gated)
```

- **`apps/web/test/static-caching.spec.ts`** — boots the production build and asserts real `Cache-Control` headers: hashed JS/CSS chunks must be `immutable, max-age=31536000`; the favicon must be cached for a real but finite window (not immutable — its URL never changes, so it can't cache forever without risking a stale icon); the HTML document must **not** be immutable-cached (content needs to go stale). This caught a real gap — the favicon had no meaningful caching at all — now fixed via `next.config.ts`'s `headers()`.
- **`apps/web/test/bundle-budget.spec.ts`** — measures actual gzip-compressed bytes (via `curl`, since Node's `fetch` transparently decompresses and can't be used to measure wire size) for every real `<script src>` a browser would load, and asserts the total stays under the §12A 150KB budget. Deliberately excludes `nomodule=""` legacy-polyfill scripts — a modern browser never downloads those at all if it supports ES modules, so counting them would overstate what real users actually transfer.
- **`apps/web/scripts/perf-budget.mjs`** (`test:perf`) — runs a real Lighthouse audit (mobile, simulated throttling) against the production build and checks it against §12A's performance-score/LCP/JS-transfer targets. Kept as a manual/periodic script rather than a CI gate — Lighthouse scores have real run-to-run variance.
- **`apps/api/scripts/load-test.mjs`** (`test:load`) — runs `autocannon` against the `products` GraphQL query and reports throughput/latency percentiles. Also informational rather than CI-gated, for the same reason.

## Localization

English + Hindi, per TECHNICAL_PLAN.md §14 — path-based routing (`/en`, `/hi`) via `next-intl`, resolved by the proxy/middleware in this priority order: **URL path prefix first** (if present, wins outright) → **`Accept-Language` header negotiation** (first visit only) → **`NEXT_LOCALE` cookie** (returning visits, set automatically once a locale is resolved). Verified directly with real requests, not just asserted from docs — see the git history for the curl checks.

- `apps/web/src/i18n/` — routing config, request config, locale-aware `Link`/`useRouter` (`@/i18n/navigation`, not `next/link` — using the plain Next one anywhere under `[locale]` loses the current locale on navigation).
- `apps/web/messages/{en,hi}.json` — UI chrome strings only.
- **Product/seller content (name, description, category) is never auto-translated** — it stays in whatever language the seller entered it in. Only platform-owned UI text (nav, buttons, labels) is translated. This is a deliberate §14 rule, not a gap: machine-translating a device's intended-use description is a liability for a medical-instruments marketplace, not a convenience.

**Switching language is instant and client-side** (`apps/web/src/components/locale-provider.tsx`) — no server round trip, no route navigation. Swapping `NextIntlClientProvider`'s `messages` prop re-renders every `useTranslations()` consumer immediately; the URL updates via `history.replaceState` (cosmetic, fires no request) rather than `next-intl`'s router, which would re-fetch the `[locale]` route segment from the server on every switch. A locale's messages are fetched at most once per session — an explicit `Map` cache (seeded with the initial server-resolved locale) means switching en→hi→en→hi only ever touches the network on the very first visit to a given language; every switch after that, in either direction, is zero requests. Verified with real network monitoring, not assumed.

This did require converting Header/Footer/Pagination/ProductCard from Server Components to Client Components (they need to react to client-side locale state) — a real, measured bundle-size cost, raised twice and documented both times in `test/bundle-budget.spec.ts` rather than silently absorbed: 150KB → 160KB → 172KB.

### Shell vs. item data — split on purpose, not by accident

`apps/web/src/app/[locale]/page.tsx` no longer fetches product data itself. Items for sale are fetched by `apps/web/src/components/product-listing.tsx`, a Client Component that calls the GraphQL API directly on mount and again whenever `?page` changes. Two reasons this split exists:

1. **Product data is genuinely dynamic** (new listings, edited descriptions/prices) and must never be treated as safe to cache alongside the shell — every load needs current DB state.
2. **The shell has no such requirement.** Splitting its data-fetching out entirely is what lets `/en` and `/hi` go back to being genuinely static, prerendered routes (confirmed via `x-nextjs-prerender: 1` and `x-nextjs-cache: HIT` — real headers, checked in `test/static-caching.spec.ts`, not assumed). A repeat visit with the same locale gets a `304 Not Modified` on the shell instead of a full re-render — no server-side work, negligible transfer, without needing a Service Worker.

**Known remaining gap**: a hard page reload still costs one small conditional-GET round trip for the shell document itself (the 304 above) — that's normal, correct HTTP behavior, not a bug, but it isn't literally zero network activity. Closing that last gap would need a Service Worker serving the shell from Cache Storage — scoped but not built (declined when offered; revisit if wanted later).

### Product data caching (GraphQL-over-GET)

The first version of this shell/data split only solved half the problem: `product-listing.tsx` still fetched via **POST**, which HTTP defines as non-cacheable regardless of any headers set — no ETag or `Cache-Control` on a POST response can make a browser or CDN reuse it. `apps/web/src/lib/api.ts`'s `fetchProductsPaged` now sends the same GraphQL query as **GET** instead (query + variables URL-encoded, per the GraphQL-over-HTTP spec — the same approach GitHub's and Shopify's GraphQL APIs use for CDN-cacheable reads), with the `apollo-require-preflight` header Apollo Server's CSRF protection requires on GET.

- `apps/api/src/app.setup.ts` — shared between `main.ts` and the e2e tests (previously two copies of bootstrap config existed and could drift) — overrides Apollo's default `Cache-Control: no-store` to `public, max-age=0, must-revalidate` **specifically for GET requests to `/graphql`**, so the real ETag Apollo already computes can actually be used for conditional revalidation. POST stays untouched (`no-store`, confirmed in `test/products.e2e-spec.ts`) — mutations and anything sent via POST must never be treated as cacheable.
- Verified with real browser Resource Timing data (not just curl): a reload shows `transferSize: 300` bytes against an actual `encodedBodySize` of ~2.5KB for the product data — the same 304 signature as the shell, confirming the browser is genuinely reusing cached product data rather than re-fetching it. Cross-origin Resource Timing values are zeroed by browsers for privacy by default; `Timing-Allow-Origin` is set explicitly so this is actually measurable, not just inferred.
- Mutations (`requestOtp`, `completeOnboarding`, etc.) and any exploratory queries sent via POST are deliberately unaffected — this override only ever applies to GET.

## Not yet built

Everything else in the roadmap (TECHNICAL_PLAN.md §9) — catalog, search, RFQ engine, lead distribution, messaging, billing, admin console, CAD-to-sourcing, etc. This is Phase 0 only: repo skeleton + auth/org onboarding foundation.
