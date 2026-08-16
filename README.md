# MedInstru Market

[![CI](https://github.com/nixsin/marketplace/actions/workflows/ci.yml/badge.svg)](https://github.com/nixsin/marketplace/actions/workflows/ci.yml)
[![CodeQL](https://github.com/nixsin/marketplace/actions/workflows/codeql.yml/badge.svg)](https://github.com/nixsin/marketplace/actions/workflows/codeql.yml)
[![Docker vulnerability scan](https://github.com/nixsin/marketplace/actions/workflows/docker-scan-scheduled.yml/badge.svg)](https://github.com/nixsin/marketplace/actions/workflows/docker-scan-scheduled.yml)
[![Dependency freshness](https://github.com/nixsin/marketplace/actions/workflows/dependency-freshness.yml/badge.svg)](https://github.com/nixsin/marketplace/actions/workflows/dependency-freshness.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![API coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/api-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)
[![Web coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/web-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)
[![Lighthouse](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/lighthouse-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)

B2B marketplace for medical & surgical instruments. Full architecture, rationale, and roadmap live in [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) — read that first.

CI metrics over time (coverage for both apps, Lighthouse performance score, all charted): **https://nixsin.github.io/marketplace/coverage/index.html** — accumulates automatically on every push to `main` that actually re-runs the relevant job (path-filtered for coverage, so gaps mean "unchanged," not "missing"; Lighthouse appends on every run regardless of pass/fail).

## Repo layout

```
apps/
  web/   Next.js (App Router, TypeScript, Tailwind, shadcn/ui)
  api/   NestJS (GraphQL via Apollo, Prisma ORM, Postgres)
packages/  shared code (empty for now — Phase 1+)
docker-compose.yml   Postgres + Redis + web + api, containerized (see below)
scripts/dev.sh        one-command setup: build, migrate, seed, run
```

This is a pnpm workspace monorepo (see `pnpm-workspace.yaml`), not two independent projects.

## Quick start (recommended)

The only prerequisite is [Docker](https://docs.docker.com/get-docker/) (Docker Desktop, or `brew install docker docker-compose colima && colima start` for a lighter CLI-only setup). Everything else — Node, pnpm, Postgres, Redis, `.env` files, migrations, seed data — is handled for you:

```bash
./scripts/dev.sh
```

First run builds the images and installs dependencies inside them (a few minutes); every run after that is fast, since Docker caches the dependency layer and only reinstalls when a `package.json` or the lockfile actually changes. When it's done:

- web → http://localhost:3000
- api → http://localhost:4000/graphql

Source is bind-mounted into both containers, so edits on your machine hot-reload exactly like running `pnpm dev` locally — nothing to rebuild for day-to-day changes. Re-running `./scripts/dev.sh` any time is safe (migrations are idempotent, a duplicate seed attempt is caught and skipped). `docker compose down` stops everything; add `-v` to also wipe the database.

### Why Docker instead of installing everything locally

One command instead of pinning a Node version, installing pnpm, installing and configuring Postgres + Redis, and remembering the exact migrate/seed sequence — and it's the same environment on any machine, not just "works on mine." The tradeoff is the first build costing a few minutes and ~2.5GB of image size per app; worth it for anyone other than the original author touching this repo.

## Alternative: running natively (no Docker)

Still fully supported, and what this machine originally used before the Docker setup existed.

### Prerequisites

- Node.js 22+ (installed here via [nvm](https://github.com/nvm-sh/nvm))
- pnpm (via `corepack enable`)
- Postgres + Redis — this machine is set up via **Homebrew** (`postgresql@16`, `redis`, both running as `brew services`).

### This machine's local setup (already done)

- `brew services start postgresql@16 redis`
- A `postgres` superuser role (password `postgres`) was created to match `docker-compose.yml`'s credentials, so `.env` doesn't need to change if you switch to Docker later: `psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"`
- Homebrew's `redis.conf` ships with `loadmodule` lines for Bloom/Search/JSON/Timeseries modules that aren't actually bundled with the formula — they were commented out in `/opt/homebrew/etc/redis.conf` (Redis was crash-looping on startup otherwise). Not needed for anything in this stack (plain caching/queues only).

### First-time setup

```bash
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

createdb medinstru   # skip if already created

# apply the Phase 0 schema (Organization, User, License — see TECHNICAL_PLAN.md §6)
pnpm --filter api exec prisma migrate dev --name init
pnpm --filter api run seed   # optional: 10 sample products
```

### Running locally

```bash
pnpm dev:web   # http://localhost:3000
pnpm dev:api   # http://localhost:4000/graphql (GraphQL Playground in dev)
```

### Calling the API from Postman

Import [`apps/api/postman/marketplace-api.postman_collection.json`](apps/api/postman/marketplace-api.postman_collection.json) for ready-made requests covering the full auth flow (request OTP → verify → complete onboarding, with the access token auto-saved to a collection variable between steps) plus the product-catalog and account queries. Every request in it is verified directly against a real running API, not just written from the schema — see the collection's own description for the exact flow, including where to find the dev-only OTP (it's logged, not actually SMSed — see `apps/api/src/auth/sms.service.ts`).

## What's scaffolded so far (Phase 0)

- Monorepo workspace (pnpm) with `apps/web` and `apps/api`.
- `apps/web`: Next.js + Tailwind + shadcn/ui (Radix base) initialized, base components added (button, input, table, dialog, card, badge, sonner).
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
pnpm --filter web test:perf                          # Lighthouse audit vs. §12A targets
pnpm --filter api test:load                           # autocannon load test
```

- **`apps/web/test/static-caching.spec.ts`** — boots the production build and asserts real `Cache-Control` headers: hashed JS/CSS chunks must be `immutable, max-age=31536000`; the favicon must be cached for a real but finite window (not immutable — its URL never changes, so it can't cache forever without risking a stale icon); the HTML document must **not** be immutable-cached (content needs to go stale). This caught a real gap — the favicon had no meaningful caching at all — now fixed via `next.config.ts`'s `headers()`.
- **`apps/web/test/bundle-budget.spec.ts`** — measures actual gzip-compressed bytes (via `curl`, since Node's `fetch` transparently decompresses and can't be used to measure wire size) for every real `<script src>` a browser would load, and asserts the total stays under budget — raised three times since the original §12A 150KB target, currently 189KB (see the file's own comment for why each raise happened). Deliberately excludes `nomodule=""` legacy-polyfill scripts — a modern browser never downloads those at all if it supports ES modules, so counting them would overstate what real users actually transfer.
- **`apps/web/scripts/perf-budget.mjs`** (`test:perf`) and **`apps/api/scripts/load-test.mjs`** (`test:load`) — a real Lighthouse audit (mobile, simulated throttling) against the production build, and an `autocannon` load test against the `products` GraphQL query, respectively. Both run in CI on every PR (`perf-budget`/`load-test` jobs in `ci.yml`). `perf-budget` (Lighthouse) is a **required check** as of 2026-08-16 — it must pass (or be skipped by the path filter) to merge. `load-test` remains informational, not required — load-test latency has real run-to-run variance, so a red X there isn't necessarily a regression. A real failure on either still gets AI root-cause analysis posted as a PR comment (`ai-failure-analysis` job).

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

## Minification & debugging prod

Standard industry split: dev is unminified for debugging; prod is minified for real users, with source maps as the mechanism to debug prod without shipping unminified code.

| | Dev | Prod |
|---|---|---|
| Web JS/CSS | Unminified (`next dev` default) | Minified + source maps (`productionBrowserSourceMaps: true` in `next.config.ts`) |
| API (NestJS) | Runs TS directly via ts-node | Compiled JS (not minified — see below) + source maps (`node --enable-source-maps`, `start:prod`) |
| GraphQL query text | N/A | Minified once at module load (`minifyGql` in `lib/api.ts`) — it travels in a URL (GraphQL-over-GET), where whitespace costs real bytes and costs *more* once percent-encoded |

- **Why the API isn't minified**: minification's entire benefit is reducing bytes a browser downloads. Backend code never leaves the server, so minifying it buys nothing and only makes prod stack traces harder to read. Source maps, not minification, are the right lever for a Node backend.
- **Source maps are opt-in for DevTools, not a page-weight cost** — browsers only fetch a `.map` file when DevTools is actually open and requests it. Regular users loading the page never download them.
- **Public source maps were a deliberate choice**, not an oversight — they can reveal original source structure to anyone who requests the `.map` file directly. Fine for this codebase today; revisit (upload to an error-tracking service instead of serving `.map` files publicly) once there's real business logic worth keeping private. Changing that later doesn't require touching the build pipeline, just where the maps end up.
- Removed `source-map-support` from the API's dependencies — it was listed (leftover from the original `nest new` scaffold) but never actually imported anywhere, so source maps were being generated but never used. Node's own `--enable-source-maps` (stable since Node 18) replaces it.

## Deployment

App code has no host-specific logic anywhere — it only reads plain environment variables. Whatever platform runs these containers just needs to set the ones below; nothing in `apps/api` or `apps/web` source ever branches on which platform it's running on.

| App | Var | Required | Notes |
|---|---|---|---|
| api | `DATABASE_URL` | yes | Postgres connection string |
| api | `JWT_SECRET` | yes | Signs/verifies auth JWTs — generate with `openssl rand -base64 32`, never reuse the `.env.example` dev value |
| api | `PORT` | no (default `3000`) | Both Dockerfiles set it to `4000` |
| api | `NODE_ENV` | no | `production` disables the GraphQL Playground (`apps/api/src/app.module.ts`) |
| api | `REDIS_URL` | not yet wired up | Reserved for Phase 1 (BullMQ queues, OTP store, caching) |
| web | `NEXT_PUBLIC_API_URL` | yes | The API's public GraphQL endpoint. Inlined into the client bundle at `next build` time (standard Next.js `NEXT_PUBLIC_*` behavior) — for a Docker build this must be passed as a `--build-arg`, not just a runtime env var; see the comment in `apps/web/Dockerfile`'s `build` stage |

Current deployment target is [Render](https://render.com) (Docker-based web services + managed Postgres) — its service definitions, regions, and plans are captured as infrastructure-as-code in [`render.yaml`](./render.yaml) (a [Render Blueprint](https://render.com/docs/blueprint-spec)) rather than living only in the dashboard. Moving to a different host later is a matter of writing that host's own infra config against the env var contract above and retiring `render.yaml` — no application code changes.

CI (`.github/workflows/ci.yml`) applies production database migrations (`prisma migrate deploy`, gated behind every other check, `main`-only) against Postgres's *external* connection string, since the prod Docker image intentionally excludes the `prisma` CLI (see `apps/api/Dockerfile`) and Render's Pre-Deploy Command is unavailable on the free instance tier.

## Not yet built

Everything else in the roadmap (TECHNICAL_PLAN.md §9) — catalog, search, RFQ engine, lead distribution, messaging, billing, admin console, CAD-to-sourcing, etc. This is Phase 0 only: repo skeleton + auth/org onboarding foundation.
