# Infrastructure overview

Who provides what, and where each piece is documented. Start here when
something is broken and you are not sure which provider owns it.

```
  GoDaddy                Cloudflare       CloudFront       Render
  ───────                ──────────       ──────────       ──────
  registers              authoritative ─► edge CDN ──────► medinstru-web (Docker)
  laxair.shop            DNS                                 medinstru-api (Docker)
      │                        │                       medinstru-postgres
      │ nameservers            │
      └───────────────────────►│  R2: medinstru-media
                               │  └─► images.laxair.shop
```

| Provider | Owns | Doc | Spend |
|---|---|---|---|
| **GoDaddy** | Domain registration only | [godaddy.md](./godaddy.md) | Annual renewal |
| **Cloudflare** | Authoritative DNS and R2 object storage | [cloudflare.md](./cloudflare.md) | $0 — free tier |
| **AWS CloudFront** | Edge delivery for the existing Render web and API origins; pending Terraform state adoption | [../infra/terraform/README.md](../infra/terraform/README.md) | Usage based |
| **Render** | Web services + Postgres | [render.md](./render.md) | $0 — free tier |

Application-level caching decisions are in
[caching-and-performance.md](./caching-and-performance.md); deploy
mechanics in [deployment.md](./deployment.md).

The deployable Render and CloudFront Terraform is under
[`infra/terraform`](../infra/terraform). It is not applied automatically;
the existing Render resources must be imported before that stack is allowed
to manage them.

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

## Nightly production audit

`.github/workflows/nightly-audit.yml` runs `scripts/production-audit.mjs`
at 02:30 UTC (08:00 IST) against the live site, and on demand via
**Actions → Nightly production audit → Run workflow**.

Run it locally against production at any time:

```bash
node scripts/production-audit.mjs
```

### Why it audits production rather than the repo

Every scheduled job in this repository checks the *codebase* — CodeQL,
dependency freshness, Trivy. None of them would have caught any of the
production failures this project has actually had, because in every case
**the code was correct and the deployed configuration was not**:

| Failure | What was wrong | How it was found |
|---|---|---|
| Share links pointed at `localhost` | `NEXT_PUBLIC_SITE_URL` unset on Render | A person, days later |
| Blob storage did nothing | Variable not declared as a Docker `ARG` | Manual audit |
| Product links previewed as bare text | API returned absolute URLs the `og:image` rule refused | Manual audit |
| Container crashed on every boot | `next.config.ts` import not copied into the prod image | Production outage |

None produced an error anywhere. This replaces the looking.

### What it checks

| Area | Checks |
|---|---|
| **Availability** | Web and API respond |
| **Deploy** | Build identity header present; live build matches `main` |
| **Previews** | `og:title` and `og:image` on home and product pages; image is absolute, a raster (not SVG), not localhost, and actually fetchable |
| **Security** | CSP and HSTS present; `frame-ancestors`, `script-src`, `img-src`, `connect-src`; CSP allows the blob host |
| **Caching** | HTML revalidates; static JS immutable; blob images immutable and edge-cached |
| **Storage** | Every product image resolves, and every SVG has its PNG twin |
| **Correlation** | Server issues `x-request-id`, exposes it to JS, caches preflight, allows `authorization` |
| **Certificates** | Days remaining for both hostnames (via CT logs) |
| **Deadlines** | Countdown to the Postgres expiry — see [render.md §6](./render.md#6-subscription-cost-and-free-tier-limits) |

### Reporting

- **Green:** publishes to the run summary and closes the tracking issue if
  one is open. It deliberately posts nothing otherwise — a daily "all
  fine" comment trains people to ignore the issue.
- **Failed:** opens or comments on a single issue titled *Nightly
  production audit*. One issue, updated — not a new issue per night.

**Warnings never fail the run.** Free-tier spin-down, a marginal
certificate window, and a deploy lagging `main` by minutes are worth
reporting and not worth paging for. An audit that cries wolf gets muted,
which is worse than not having one.

Third-party lookups that fail (the CT log) report as **skipped**, never
failed — someone else's outage is not ours.
