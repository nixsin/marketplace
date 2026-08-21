# Render — hosting and database

Where the app actually runs: two Docker web services and a Postgres
database. Configuration, caching behaviour, costs, and what changes if
we move.

Related: [cloudflare.md](./cloudflare.md) (DNS in front, R2 for images),
[godaddy.md](./godaddy.md) (registrar), and
[deployment.md](./deployment.md) (deploy mechanics and the migration
job). `render.yaml` at the repo root is the machine-readable companion
to this file.

---

## 1. Services

| Service | Type | Runtime | Plan | Public URL |
|---|---|---|---|---|
| `medinstru-web` | Web | Docker | Free | `laxair.shop` (+ `www`, + `medinstru-web.onrender.com`) |
| `medinstru-api` | Web | Docker | Free | `medinstru-api.onrender.com` |
| `medinstru-postgres` | Postgres | — | **Free** | Internal + external connection strings |

`medinstru-web` service ID: `srv-da02mt61egvs73fopb00`.

**`render.yaml` is documentation, not an active Blueprint sync.** Values
in it do not take effect automatically — every environment variable must
also be set by hand in the dashboard. This has caused real production
bugs (see §3), so treat the file as a reference for *what should be set*,
not as a guarantee that it *is*.

---

## 2. Custom domains

Under each service's **Settings → Custom Domains**:

| Domain | Service | Status |
|---|---|---|
| `laxair.shop` | `medinstru-web` | Verified, certificate issued |
| `www.laxair.shop` | `medinstru-web` | Verified, **redirects to apex** (Render handles this) |
| `api.laxair.shop` | `medinstru-api` | Verified, certificate issued |

`api.laxair.shop` exists so GraphQL GETs can be edge-cached. The
`.onrender.com` hostname sits behind **Render's** Cloudflare, which
returns `cf-cache-status: DYNAMIC` and caches nothing of ours, so
`s-maxage` was inert until this domain existed — see
[cloudflare.md §5.3b](./cloudflare.md#53b-caching-the-api--apilaxairshop-and-its-cache-rule).

**Setup order matters.** Render verifies ownership and issues a
certificate by reaching the origin directly, so the DNS records must be
**grey-cloud / DNS-only** during verification. Proxying through
Cloudflare first causes verification to fail with no useful error. Only
enable the proxy after Render reports *Certificate Issued* — see
[cloudflare.md §5.3](./cloudflare.md#53-enabling-the-cdn-for-the-app).

The apex uses a CNAME to `medinstru-web.onrender.com` rather than
Render's published A record, because those IPs change — see
[cloudflare.md §2.3](./cloudflare.md#23-why-the-apex-is-cname-not-a).

---

## 3. Environment variables

**`NEXT_PUBLIC_*` values are inlined at BUILD time.** A Docker build only
receives them if `apps/web/Dockerfile` declares a matching `ARG` — a
variable set in the dashboard but absent from the Dockerfile silently
never arrives. This has bitten twice, both times failing silently, and is
now enforced by a test (`apps/web/test/dockerfile-env.spec.ts`).

**A restart does not apply a changed `NEXT_PUBLIC_*` value — only a
rebuild does.** Render's *Restart* reuses the existing image, and these
values are compiled into the JS bundle by `next build`. Changing one in
the dashboard and restarting looks like it worked and changes nothing.
Use **Manual Deploy → Deploy latest commit**.

This is directly observable without guessing, because the CSP header is
generated at build time from the same variable:

`curl -sI` (HEAD) is correct for these two header checks, and stays correct
once the Cloudflare HTML cache rule is live: those rules are method-gated, so
a HEAD always bypasses the edge and reads the origin's current build -- which
is exactly what you want when asking "what is deployed". Do **not** copy this
pattern into a cache check, where a HEAD reports `DYNAMIC` unconditionally and
tells you nothing (see infra/terraform/README.md).

```bash
curl -sI https://laxair.shop/en | tr ';' '\n' | grep connect-src
#   connect-src 'self' https://api.laxair.shop
```

If that still names the old host, the new value is not in the build yet.
Hit live on 2026-08-21 during the `api.laxair.shop` cutover: the variable
was set and both services restarted, and the deployed bundle still called
`medinstru-api.onrender.com`.

### `medinstru-web`

| Key | Value | When read |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.laxair.shop/graphql` | Build |
| `NEXT_PUBLIC_SITE_URL` | `https://laxair.shop` | Build |
| `NEXT_PUBLIC_BLOB_BASE_URL` | `https://images.laxair.shop` | Build |

`NEXT_PUBLIC_SITE_URL` is **required** — the build fails deliberately if
it is unset, malformed, or points at a local address
(`apps/web/src/lib/site-url.ts`). It was once unset in production, which
made every WhatsApp share link and preview image point at
`http://localhost:3000`.

### `medinstru-api`

| Key | Value | When read |
|---|---|---|
| `PORT` | `4000` | Runtime |
| `DATABASE_URL` | From `medinstru-postgres` | Runtime |
| `JWT_SECRET` | Set manually (`openssl rand -base64 32`) | Runtime |
| `NEXT_PUBLIC_BLOB_BASE_URL` | `https://images.laxair.shop` | **Runtime** |

**The blob URL is needed on BOTH services, for different reasons.** The
web app uses it at build time to derive the CSP `img-src` entry and the
`next/image` allowlist; the API uses it at runtime to rewrite each
product's `imageUrl`. Setting only one produces a half-configured state
where the web app permits a host that nothing ever points at.

### Secrets

`JWT_SECRET` is the only true secret held by Render, set manually and
never committed. R2 credentials are **not** stored here today — they live
in a developer's shell for migrations only
([cloudflare.md §4](./cloudflare.md#4-keys-and-secrets)). That changes if
seller uploads land.

---

## 4. Deployment

`autoDeployTrigger: checksPass` — Render waits for all required GitHub
checks before deploying. This is a second reason never to route around a
red required check.

Database migrations run in **CI**, not on Render: the prod image has no
Prisma CLI (`pnpm deploy --prod` drops devDependencies) and Render's free
tier locks the Pre-Deploy Command. See
[deployment.md](./deployment.md).

**Build identity** is baked into every response so deploy skew is
visible:

```bash
curl -sI https://laxair.shop/en | grep x-build
#   x-build-commit: <sha>
#   x-build-time:   <iso8601>
```

Compare against `git rev-parse origin/main`. This exists because four
rapid merges once left Render deploying stale commits with nothing
exposing the mismatch.

### Reading deploy failures

A **failed deploy** shows a stack trace, no `Ready`, and a non-zero exit.
**Infrastructure trouble** shows successful boots that do not survive —
repeated `✓ Ready in …` lines with a *different* network IP each time,
which means new containers, not a crashing app. The two need completely
different responses; do not treat the second as a code problem.

---

## 5. Caching

Render itself adds no caching layer. What reaches the browser is
whatever the apps send:

| Response | `Cache-Control` | Set by |
|---|---|---|
| Locale HTML (`/en`, `/hi`) | `public, max-age=0, must-revalidate` | `next.config.ts` `headers()` |
| `/_next/static/*` | `public, max-age=31536000, immutable` | Next.js |
| `/favicon.ico` | long-lived | `next.config.ts` |
| GraphQL GET | `public, max-age=0, must-revalidate` | `apps/api/src/app.setup.ts` |
| GraphQL POST | `no-store` | Apollo default |

Render fronts services with **its own** Cloudflare — hence
`server: cloudflare` plus `x-render-origin-server: Render` on responses.
That is not our CDN and does not cache our static assets; see
[cloudflare.md §5.2](./cloudflare.md#52-the-gap).

The API also sets `Timing-Allow-Origin: *` on cacheable GETs so real
transfer sizes and timings are visible to browser Resource Timing —
without it, cross-origin values are zeroed and cache behaviour cannot be
measured from the frontend.

---

## 6. Subscription, cost, and free-tier limits

**Current spend: $0.00.** Everything is on Render's free tier — and the
free tier has real teeth here.

| Service | Plan | Limit | Consequence |
|---|---|---|---|
| `medinstru-web` | Free | **Spins down after ~15 min idle** | First request after idle takes ~50s |
| `medinstru-api` | Free | Same | Same |
| Both | Free | 750 instance-hours/month across free services | Services stop when exhausted |
| Both | Free | Builds/deploys disabled during incidents | Observed 2026-08-20: a GCP upstream incident disabled free builds and spin-up entirely |
| `medinstru-postgres` | Free | **Deleted 30 days after creation** | **Expires 2026-09-14** |

### ⚠️ The database expiry is the critical item

Free Postgres on Render is **deleted**, not paused, 30 days after
creation. Created 2026-08-15 → **expires 2026-09-14**. When that happens
the production database and everything in it is gone.

Before that date, either upgrade to a paid instance or recreate and
reseed. There is currently **no backup strategy** — see
[#7 in the task list] and treat that as a prerequisite, not a follow-up.

### Free-tier failure modes seen in practice

- **Spin-down latency** — a cold first request is slow, which is a real
  problem for a marketplace where the first impression is a product page.
- **Deploys disabled during platform incidents** — free services are shed
  first. Observed for ~1 hour on 2026-08-20.
- **Database deletion** — above.

The first two are annoyances; the third destroys data. If any part of
this moves to paid, the database should be first.

---

## 7. Migrating away from Render

The app is containerised and holds no Render-specific code, so the move
is mostly configuration.

### 7.1 What is portable as-is

- Both services are plain Dockerfiles — they run anywhere that runs
  containers (Fly.io, Railway, Cloud Run, ECS, a VPS).
- All configuration is environment variables (§3).
- Nothing imports a Render SDK.

### 7.2 What changes

| Concern | Today | After a move |
|---|---|---|
| Build args | Render passes dashboard env vars as Docker build args | **Verify the new platform does too** — several do not, and `NEXT_PUBLIC_*` would silently vanish (§3) |
| `RENDER_GIT_COMMIT` | Set by Render at build | Replace with the platform's equivalent; used for build identity and the deploy guard |
| Custom domains | Render issues certificates | Reissue at the new platform, or terminate TLS at Cloudflare instead |
| Migrations | CI job against the external DB URL | Unchanged if the new DB is reachable from CI |
| Auto-deploy | `autoDeployTrigger: checksPass` | Reimplement the "wait for green CI" gate — many platforms deploy on push regardless |
| `render.yaml` | Documentation only | Replace with the new platform's manifest |

### 7.3 Moving the database

The heavier half. Postgres is standard, so `pg_dump`/`pg_restore` moves
it — but plan for:

- **Downtime or a read-only window** during the dump/restore.
- **`DATABASE_URL` updated** on the API service and in the CI migration
  job.
- **Connection limits** — Render's free tier is small; a new provider
  may need pool tuning.
- **Region** — currently Oregon while buyers are in India. A move is the
  natural moment to relocate closer, which would cut a large fixed
  latency from every query.

### 7.4 Order of operations

1. Stand up the new environment with the same env vars.
2. Deploy and verify against the platform's own hostname.
3. Migrate the database during a quiet window.
4. Repoint DNS in Cloudflare ([cloudflare.md §2.2](./cloudflare.md#22-dns-records))
   — this is the cutover, and it is the step that is reversible in
   minutes if something is wrong.
5. Keep Render running until the new setup is proven, then decommission.

---

## 8. Known state and open items

- **Postgres expires 2026-09-14** — §6. Highest-priority item in this
  document.
- **No database backups** configured.
- **Free-tier spin-down** affects real first-visit latency.
- **`render.yaml` is not synced** — dashboard is the source of truth;
  the file can drift and has.

[#7 in the task list]: https://github.com/nixsin/marketplace/issues
