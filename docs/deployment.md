# Deployment

> Provider-specific configuration, costs and migration notes:
> [render.md](./render.md), [cloudflare.md](./cloudflare.md),
> [godaddy.md](./godaddy.md) — indexed in
> [infrastructure.md](./infrastructure.md).


App code has no host-specific logic anywhere — it only reads plain environment variables. Whatever platform runs these containers just needs to set the ones below; nothing in `apps/api` or `apps/web` source ever branches on which platform it's running on.

| App | Var | Required | Notes |
|---|---|---|---|
| api | `DATABASE_URL` | yes | Postgres connection string |
| api | `JWT_SECRET` | yes | Signs/verifies auth JWTs — generate with `openssl rand -base64 32`, never reuse the `.env.example` dev value. Unset in a real deployment now fails the app at boot rather than silently falling back to a public placeholder. |
| api | `PORT` | no (default `3000`) | Both Dockerfiles set it to `4000` |
| api | `NODE_ENV` | no | `production` disables the GraphQL Playground (`apps/api/src/app.module.ts`) |
| api | `REDIS_URL` | not yet wired up | Reserved for Phase 1 (BullMQ queues, OTP store, caching) |
| web | `NEXT_PUBLIC_API_URL` | yes | The API's public GraphQL endpoint. Inlined into the client bundle at `next build` time (standard Next.js `NEXT_PUBLIC_*` behavior) — for a Docker build this must be passed as a `--build-arg`, not just a runtime env var; see the comment in `apps/web/Dockerfile`'s `build` stage |
| web | `RENDER_GIT_COMMIT` | no | Feeds Next's `deploymentId` for stale-tab detection — see `apps/web/next.config.ts`'s own comment and [issue #78](https://github.com/nixsin/marketplace/issues/78) §3.3 |

## Current target: Render

[Render](https://render.com) (Docker-based web services + managed Postgres) — its service definitions, regions, and plans are captured as infrastructure-as-code in [`render.yaml`](../render.yaml) (a [Render Blueprint](https://render.com/docs/blueprint-spec)) rather than living only in the dashboard. Moving to a different host later is a matter of writing that host's own infra config against the env var contract above and retiring `render.yaml` — no application code changes.

CI (`.github/workflows/ci.yml`) applies production database migrations (`prisma migrate deploy`, gated behind every other check, `main`-only) against Postgres's *external* connection string, since the prod Docker image intentionally excludes the `prisma` CLI (see `apps/api/Dockerfile`) and Render's Pre-Deploy Command is unavailable on the free instance tier.

Both services deploy automatically once every required CI check passes (`autoDeployTrigger: checksPass` in `render.yaml`) — see [CLAUDE.md](../CLAUDE.md) for the full CI pipeline and the operational discipline around required checks.

**Free-tier note**: `medinstru-postgres` is on Render's free tier and both web services spin down after 15 minutes idle, so a cold visit to the live app can take 30-50s on the first request. The app's service worker mitigates this for repeat visits (see [docs/caching-and-performance.md](./caching-and-performance.md)).
