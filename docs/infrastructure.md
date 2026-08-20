# Infrastructure overview

Who provides what, and where each piece is documented. Start here when
something is broken and you are not sure which provider owns it.

```
  GoDaddy                Cloudflare                    Render
  ───────                ──────────                    ──────
  registers              authoritative DNS ──────────► medinstru-web   (Docker)
  laxair.shop            for laxair.shop               medinstru-api   (Docker)
      │                        │                       medinstru-postgres
      │ nameservers            │
      └───────────────────────►│  R2: medinstru-media
                               │  └─► images.laxair.shop
```

| Provider | Owns | Doc | Spend |
|---|---|---|---|
| **GoDaddy** | Domain registration only | [godaddy.md](./godaddy.md) | Annual renewal |
| **Cloudflare** | DNS, R2 object storage, (CDN available but off for the app) | [cloudflare.md](./cloudflare.md) | $0 — free tier |
| **Render** | Web services + Postgres | [render.md](./render.md) | $0 — free tier |

Application-level caching decisions are in
[caching-and-performance.md](./caching-and-performance.md); deploy
mechanics in [deployment.md](./deployment.md).

## The two items that need action

1. **Render Postgres is deleted on 2026-09-14.** Free-tier Postgres is
   removed 30 days after creation — not paused, deleted. There is no
   backup strategy. [render.md §6](./render.md#6-subscription-cost-and-free-tier-limits)
2. **Confirm the domain auto-renews.** Everything else here is
   recoverable; a lapsed domain is the one thing that is not.
   [godaddy.md §6](./godaddy.md#6-subscription-cost-and-limits)

## Where a request actually goes

```
browser
  └─► laxair.shop            DNS: Cloudflare  →  origin: Render (NOT proxied)
  └─► images.laxair.shop     DNS: Cloudflare  →  origin: R2     (proxied, edge-cached)
  └─► medinstru-api…         DNS: Render      →  origin: Render
```

The asymmetry is deliberate but incomplete: images are edge-cached, the
app is not. That gap and how to close it are in
[cloudflare.md §5](./cloudflare.md#5-caching--what-is-cached-and-what-is-not).
