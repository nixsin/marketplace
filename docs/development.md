# Development

Local setup, running the apps, and testing. For architecture and roadmap, see [TECHNICAL_PLAN.md](../TECHNICAL_PLAN.md). For deployment, see [docs/deployment.md](./deployment.md).

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

Import [`apps/api/postman/marketplace-api.postman_collection.json`](../apps/api/postman/marketplace-api.postman_collection.json) for ready-made requests covering the full auth flow (request OTP → verify → complete onboarding, with the access token auto-saved to a collection variable between steps) plus the product-catalog and account queries. Every request in it is verified directly against a real running API, not just written from the schema — see the collection's own description for the exact flow, including where to find the dev-only OTP (it's logged, not actually SMSed — see `apps/api/src/auth/sms.service.ts`).

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
