# Cloudflare — DNS, CDN, and R2 object storage

What Cloudflare does for this project, how it is configured, what it
caches, what it costs, and what changes if we leave.

Related: [godaddy.md](./godaddy.md) (registrar — where the domain is
bought and where nameservers are delegated from) and
[render.md](./render.md) (hosting — the origin Cloudflare points at).
Application-level caching decisions live in
[caching-and-performance.md](./caching-and-performance.md); this file
covers the infrastructure underneath them.

---

## 1. What we use it for

Three separate jobs, worth separating because they have different
configuration, different costs, and different failure modes:

| Job | Status | Notes |
|---|---|---|
| **Authoritative DNS** for `laxair.shop` | Active | Nameservers delegated from GoDaddy |
| **R2 object storage** for product images | Active | Bucket `medinstru-media`, served via `images.laxair.shop` |
| **CDN / proxy** for the app itself | **NOT enabled** | Apex is "DNS only" (grey cloud) — see §5 |

The third one is the significant gap. Images are edge-cached; the app is
not. See §5 for what that costs and how to turn it on.

---

## 2. Setup — DNS

### 2.1 Delegation

The domain is registered at GoDaddy and its nameservers point to
Cloudflare. See [godaddy.md §2](./godaddy.md#2-setup--nameserver-delegation).

Current nameservers (verify with `dig +short NS laxair.shop`):

```
trace.ns.cloudflare.com
daniella.ns.cloudflare.com
```

These are assigned per-zone by Cloudflare and differ for every account —
do not copy them to another zone.

### 2.2 DNS records

| Type | Name | Content | Proxy | Purpose |
|---|---|---|---|---|
| CNAME | `laxair.shop` (`@`) | `medinstru-web.onrender.com` | **DNS only** (grey) | The app |
| CNAME | `www` | `medinstru-web.onrender.com` | **DNS only** (grey) | Redirects to apex by Render |
| CNAME | `images` | *(managed by R2 custom domain)* | **Proxied** (orange) | Product images |
| TXT | `_dmarc` | `v=DMARC1; p=…` | DNS only | Email authentication |

**Records deliberately removed during setup.** Cloudflare imported these
from GoDaddy at onboarding and they broke the site until deleted:

- `A @ → 13.248.243.5` and `A @ → 76.223.105.230` — GoDaddy parking
  (both resolve to `awsglobalaccelerator.com`). These caused Render to
  return `404` for the domain and `www` to return `522`.
- `CNAME pay → paylinks.commerce…` and `CNAME _domainconnect` — GoDaddy
  service records, unused here.

If you ever re-import records from a registrar, check for these again.

### 2.3 Why the apex is CNAME, not A

Render publishes an A record target, but the IPs behind
`medinstru-web.onrender.com` change (observed as `216.24.57.7`,
`.15`, and `.1` at different times). A CNAME follows automatically;
a hardcoded A record breaks silently later. Cloudflare flattens CNAMEs
at the apex, so this is valid despite the usual DNS restriction.

---

## 3. Setup — R2 object storage

### 3.1 Bucket

| Setting | Value |
|---|---|
| Bucket name | `medinstru-media` |
| Location | **Asia-Pacific (APAC)** — chosen for Indian buyers |
| Created | 2026-08-20 |
| Public access | via custom domain only (see §3.2) |
| Account ID | `e922aa08db001f9e90a323fc6765e529` |

The account ID is an **identifier, not a secret** — it appears in the
public S3 endpoint hostname. It is safe in this file. Access keys are
not; see §4.

S3 endpoint (derived, not stored):

```
https://e922aa08db001f9e90a323fc6765e529.r2.cloudflarestorage.com
```

### 3.2 Custom domain

`images.laxair.shop` is attached to the bucket under **R2 → bucket →
Settings → Custom Domains**. Cloudflare creates the DNS record and issues
the certificate automatically.

**Use the custom domain, not the `r2.dev` Public Development URL.** The
latter is rate-limited and documented by Cloudflare as unsuitable for
production. The bucket's "Public Development URL" is deliberately
**disabled**.

### 3.3 CORS

**Deliberately not configured, and not needed.** Images are loaded via
`<img>` tags and Next's server-side image optimiser, neither of which is
subject to CORS. Only add a CORS policy if JavaScript ever needs to
`fetch()` these objects directly.

### 3.4 Uploading objects

`apps/api/scripts/upload-blobs.mjs`, run by a person with credentials in
their shell — never in CI, since that would mean every deploy holds
credentials it does not otherwise need. It is idempotent, refuses to run
against the `local` provider, and names a missing credential without
echoing its value.

```bash
BLOB_PROVIDER=r2 \
BLOB_ACCOUNT=e922aa08db001f9e90a323fc6765e529 \
BLOB_BUCKET=medinstru-media \
BLOB_ACCESS_KEY_ID=<key> \
BLOB_SECRET_ACCESS_KEY=<secret> \
node apps/api/scripts/upload-blobs.mjs --dry-run
```

Drop `--dry-run` to write. Currently holds 10 objects (5 category
illustrations, each as `.svg` for the page and `.png` for link previews —
see `apps/web/src/lib/og-image.ts` for why both exist).

---

## 4. Keys and secrets

**No credential values appear in this repository or in this file.** The
codebase stores only env var *names* and resolves values at call time —
see `resolveBlobCredentials` in `apps/api/src/storage/blob-config.ts`,
which throws naming only the missing variable so a misconfiguration
cannot leak a partially-set key into a public CI log.

| Credential | Where it lives | Scope |
|---|---|---|
| `BLOB_ACCESS_KEY_ID` | Your shell (migrations) | R2 Account API token |
| `BLOB_SECRET_ACCESS_KEY` | Your shell (migrations) | shown once at creation |

**Token configuration** (Cloudflare → R2 → Manage API Tokens):

| Field | Value | Why |
|---|---|---|
| Type | **Account** API token | Survives independently of a user; User tokens go inactive if the user leaves |
| Permission | **Object Read & Write** | The script only puts and heads objects; Admin is unnecessary surface |
| Scope | **`medinstru-media` only** | A leaked key cannot touch buckets added later |

If a key is lost, revoke and create a new one — the secret is
unrecoverable by design.

**Not yet needed, but will be:** if seller uploads land ([#93]), the API
service will need these as runtime secrets on Render rather than in a
shell. That changes the storage location, not the token configuration.

---

## 5. Caching — what is cached and what is not

This is the section most worth keeping accurate, because the answer is
counter-intuitive today.

### 5.1 Current state, measured

| Layer | Cache-Control | Edge status | Cached at Cloudflare? |
|---|---|---|---|
| **R2 images** (`images.laxair.shop`) | `public, max-age=31536000, immutable` | `cf-cache-status: HIT` | **Yes** |
| **App HTML** (`laxair.shop`) | `public, max-age=0, s-maxage=60, stale-while-revalidate=300` | `DYNAMIC` | Not yet — `s-maxage` activates when the apex is proxied (§5.3) |
| **App JS/CSS** (`/_next/static/*`) | `public, max-age=31536000, immutable` | `DYNAMIC` | **No — and this is the gap** |
| **GraphQL API** | `public, max-age=0, s-maxage=60, stale-while-revalidate=300` | `DYNAMIC` | Not yet — the API answers on `onrender.com`, fronted by RENDER's Cloudflare, which does not cache our responses. Activates behind `api.laxair.shop` |

### 5.2 The gap

Static chunks already send the ideal header — content-hashed, immutable,
a perfect CDN candidate. They are **not** edge-cached, because
`laxair.shop` is grey-cloud: the request never passes through our
Cloudflare zone. Every visitor fetches ~190KB of JS from Render's
region on every cold visit.

`server: cloudflare` on app responses is misleading — that is *Render's
own* Cloudflare (confirmed by the `x-render-origin-server: Render`
header), not ours.

### 5.3 Enabling the CDN for the app

Deliberately not done yet, and deliberately a separate change from
anything else:

1. Set **SSL/TLS → Full (strict)** **first**. On Flexible, Cloudflare
   talks HTTP to an origin that redirects to HTTPS, producing an
   infinite redirect loop.
2. Switch the apex and `www` records to **Proxied** (orange cloud).
3. Verify `cf-cache-status` becomes `HIT` for `/_next/static/*`.

Do this on its own, not alongside an app deploy — otherwise a failure is
ambiguous between the two.

**Note on ordering:** during initial setup the records had to be
**grey-cloud** so Render could verify domain ownership and issue its
certificate. Proxying before that fails verification. Only turn the
proxy on after Render shows *Certificate Issued*.

### 5.3a Why the origin already sends `s-maxage`

Both the HTML shell and cacheable GraphQL GETs now send
`s-maxage` and `stale-while-revalidate`, even though no CDN of ours
serves them yet. Three directives, three audiences:

| Directive | Applies to | Effect here |
|---|---|---|
| `max-age=0` | The browser's private cache | Always revalidates, so a deploy or a catalogue edit is picked up |
| `s-maxage=60` | Shared caches only | **Dormant** until the origin is proxied |
| `stale-while-revalidate=300` | Browsers *and* CDNs | **Working today** — a repeat navigation renders from cache instead of blocking on the network |

Shipping the header ahead of the CDN is deliberate: it is correct either
way, and it means enabling the proxy is a DNS change on its own rather
than a DNS change coordinated with a code deploy.

`s-maxage` is 60s because there is **no cache-invalidation path** — nothing
purges when a seller edits a listing, so that value doubles as the
worst-case staleness they would see. Raise it once an invalidation hook
exists, not before.

### 5.4 Purging

No purge token is configured, and none is needed yet: every cached asset
is content-hashed or immutable, so a deploy produces new URLs rather than
requiring invalidation. If mutable assets are ever cached, create a
scoped **Cache Purge** token and document it here.

---

## 6. Subscription, cost, and free-tier limits

**Current spend: $0.00.** Everything below is on free tiers.

| Product | Plan | Limits | Current usage | What happens at the limit |
|---|---|---|---|---|
| **DNS** | Free | Unlimited queries | — | N/A — DNS is free on all Cloudflare plans |
| **CDN / proxy** | Free | Unlimited bandwidth | Not enabled for the app | N/A |
| **R2 storage** | Free | 10 GB/month | ~0.3 MB (10 objects) | $0.015/GB-month beyond |
| **R2 Class A ops** (write/list) | Free | 1M/month | ~11 | $4.50/million beyond |
| **R2 Class B ops** (read) | Free | 10M/month | ~12 | $0.36/million beyond |
| **R2 egress** | **Free, always** | Unlimited | — | **No egress charge, ever** — the main reason R2 was chosen over S3 |

**No credit card obligation at current usage.** Set a **Budget Alert**
(R2 → Usage → Add Budget Alert) so a runaway upload loop cannot surprise
you.

**Cost comparison if we ever leave R2:** AWS S3 charges roughly
$0.09/GB egress. For an image-heavy catalogue served to a distant region,
egress typically dominates storage cost — this is the single biggest
financial reason to stay on R2.

---

## 7. Migrating away from Cloudflare

What changes, by job — they can be moved independently.

### 7.1 Moving DNS only

Change nameservers at GoDaddy ([godaddy.md §2](./godaddy.md#2-setup--nameserver-delegation))
and recreate the records in §2.2 at the new provider.

**Watch out:** apex CNAME flattening is a Cloudflare feature. A provider
without it (or without ALIAS/ANAME) forces an A record at the apex — and
Render's IPs change, so you would need a monitor or accept periodic
breakage. Route 53 (ALIAS) and most modern providers support this;
older registrar DNS often does not.

### 7.2 Moving object storage

The application is already provider-agnostic by design. R2, AWS S3,
Backblaze B2, DigitalOcean Spaces, MinIO and Wasabi all speak the S3
API, so switching is **configuration only**:

```
BLOB_PROVIDER=s3          # or b2, spaces, minio
BLOB_REGION=ap-south-1
BLOB_BUCKET=…
BLOB_ACCESS_KEY_ID / BLOB_SECRET_ACCESS_KEY
NEXT_PUBLIC_BLOB_BASE_URL=https://…
```

The provider table lives in `apps/api/src/storage/blob-config.ts`; there
is deliberately **no per-provider branching anywhere in the code**, and a
test asserts every provider resolves its endpoint from config alone.

A provider that does *not* speak S3 (Azure Blob, GCS native) needs one
new adapter implementing the five methods of the `BlobStore` port in
`apps/api/src/storage/blob-store.ts`, and nothing else in the app changes.

**Steps:** create the bucket → copy objects (`rclone` handles S3-to-S3
directly) → point a custom domain at it → update the env vars above on
**both** Render services → deploy.

### 7.3 Moving the CDN

Nothing in the application depends on Cloudflare specifically. Cache
behaviour is driven entirely by `Cache-Control` headers the app already
sends (see §5.1), which any CDN honours. Switching means repointing DNS
and re-checking that `immutable` assets are cached at the edge.

---

## 8. Known state and open items

- **App CDN not enabled** — §5.3. The largest available latency win.
- **`NEXT_PUBLIC_BLOB_BASE_URL` must be set on BOTH Render services.**
  The web app needs it at *build* time (it derives CSP and
  `next/image` allowlists); the API needs it at *runtime* (it rewrites
  each product's `imageUrl`). Setting only one leaves a half-configured
  state where the web app permits a host that nothing points at — which
  is exactly how this shipped the first time, silently. See
  [render.md §3](./render.md#3-environment-variables).
- **No cache-purge token** — §5.4, not needed while all assets are
  immutable.

[#93]: https://github.com/nixsin/marketplace/issues/93
