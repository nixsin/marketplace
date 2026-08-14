# MedInstru Market — Technical Plan
### A purpose-built B2B marketplace for medical & surgical instruments

## 0. Assumptions (flag anything you want changed)

- **Vertical**: medical/surgical/diagnostic instruments & equipment — not pharma, not consumer health.
- **Business model**: IndiaMart-style lead generation as the default (buyers send inquiries/RFQs, sellers pay for lead access via subscription/credits), with an optional "Buy Now" checkout for standardized low-value consumables (gloves, syringes, reagents) where price-shopping makes sense. Capital equipment (X-ray machines, ventilators, OT tables) stays inquiry-based — nobody buys a ₹15L C-arm off a cart.
- **Geography**: India-first (CDSCO regulatory model, GST, INR, Hindi/English), architected to extend to export markets later.
- **Users**: hospitals, clinics, diagnostic labs, nursing homes, government procurement, individual practitioners (buyers); manufacturers, authorized distributors, importers (sellers).
- **Team/stage**: greenfield, small team, ship an MVP fast, iterate.

---

## 1. Why this is *not* a generic marketplace clone

Medical instruments carry regulatory and trust requirements that a generic IndiaMart clone doesn't handle. These drive several architecture decisions below:

| Domain fact | Product/technical consequence |
|---|---|
| Devices are classified by risk (CDSCO Class A/B/C/D) | Product schema needs a `device_class` + regulatory metadata block, not free-text specs |
| Sellers must hold valid licenses (CDSCO Manufacturing/Import license, GST, Udyam) | KYC/verification pipeline with document upload + expiry tracking, not just email verification |
| Buyers need proof docs at purchase time (IFU, calibration certs, warranty card, CE/ISO 13485 certs) | Document management per SKU, versioned, downloadable, tied to the specific unit/batch where relevant |
| High-value capital equipment needs demos, AMC (annual maintenance contracts), installation & training | "Product" is really "Product + Service bundle" — model AMC/installation as attachable service line items |
| Govt hospitals buy via tender/GeM-style processes | RFQ engine must support multi-quote comparison, not just 1:1 chat |
| Some goods need cold-chain / calibration-sensitive logistics | Shipping metadata per SKU (temperature control, fragility, calibration-before-dispatch flag) |
| Patient-adjacent data + India's DPDP Act 2023 | Stricter PII handling than a typical marketplace, especially for any buyer field capturing hospital/patient context |

This is the core argument for building purpose-built rather than reskinning a generic template: **the product catalog schema, the trust/verification layer, and the RFQ engine all need domain-specific fields that a generic marketplace won't have.**

---

## 2. User roles

1. **Buyer** — hospital/clinic procurement staff, distributor, individual practitioner, government buyer.
2. **Seller** — manufacturer, authorized distributor, importer. Sub-roles: seller-admin, seller-staff (sales rep responding to leads).
3. **Platform admin** — approves seller KYC, moderates listings, handles disputes, manages categories/taxonomy.
4. **(Phase 2) Service partner** — third-party installation/AMC/calibration providers, bookable through the platform.

---

## 3. Business model & monetization (mirrors IndiaMart, adapted)

- **Seller subscription tiers** (Basic/Silver/Gold) — storefront limits, number of product listings, lead credits/month, search ranking boost.
- **Pay-per-lead credits** for overflow beyond subscription.
- **Featured listing / category sponsorship** ad slots.
- **Transaction fee** (small %) only on the optional Buy-Now consumables path.
- **(Later)** Verified Supplier badge as a paid trust upsell — ties into the KYC pipeline, which the platform needs to build anyway for compliance, so it's a natural monetization layer on top of a required feature.

---

## 4. High-level architecture

```
          ┌────────────────┐        ┌──────────────────────┐
          │  Web (Next.js)  │        │  Native apps (later)  │
          │  Admin console  │        │  iOS / Android         │
          └────────┬────────┘        └───────────┬───────────┘
                   │ GraphQL (Apollo)              │ gRPC (protobuf, HTTP/2)
                   ▼                                ▼
          ┌──────────────────────────────────────────────────┐
          │                 NestJS core (hybrid app)           │
          │      GraphQL resolvers  |  gRPC controllers        │
          │      REST controllers (webhooks: Razorpay, MSG91)  │
          └───────────────────────┬────────────────────────────┘
          ┌────────────┬───────────┼───────────┬───────────────┬────────────────┐
          ▼            ▼           ▼           ▼               ▼                ▼
   ┌────────────┐┌───────────┐┌──────────┐┌───────────┐┌───────────────┐┌───────────────┐
   │  Catalog    ││  RFQ /    ││  Identity/││  Messaging ││  Search        ││  CAD Intel.    │
   │  Service    ││  Lead Svc ││  KYC Svc  ││  Service   ││  Service (ES)  ││  Svc (Phase 5) │
   └─────┬──────┘└─────┬─────┘└────┬─────┘└─────┬─────┘└───────┬───────┘└───────┬───────┘
         │              │            │             │              │                │ job queue
         ▼              ▼            ▼             ▼              ▼                ▼
   ┌──────────────────────────────────────────────────────────────────┐  ┌──────────────────┐
   │   PostgreSQL (system of record)   |   Elasticsearch (search idx)  │  │ Python worker(s)  │
   │   S3-compatible object store (docs/images)  |  Redis (cache/queue)│  │ OCCT/CAD-exchange │
   └──────────────────────────────────────────────────────────────────┘  └──────────────────┘

   Cross-cutting: Payments (Razorpay/Stripe), Notifications (SMS/WhatsApp/Email),
   Analytics/Events pipeline, Admin/Ops console
```

**Transport is hybrid by client, not by preference**: GraphQL serves the web app (flexible nested queries fit dashboard-style UI best); gRPC serves native iOS/Android apps (binary protobuf over HTTP/2 — smaller payloads, multiplexed persistent connections, typed codegen straight into Swift/Kotlin — the actual "low latency, network efficient" requirement for mobile). Both transports sit in front of the *same* NestJS services, so business logic isn't duplicated. Webhooks stay plain REST. The CAD Intelligence Service is deliberately drawn as a separate Python worker pool, not a module in the monolith — see §7b.

Start as a **modular monolith** (one deployable, clean internal module boundaries matching the boxes above) rather than microservices — team size and stage don't justify distributed-systems overhead yet. Boundaries are still enforced in code so services can be peeled off later (Search and Notifications are the first candidates to split, since they have different scaling/latency profiles).

---

## 5. Tech stack (pragmatic default)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (React) + TypeScript | SSR for SEO-critical product/category pages (organic search is IndiaMart's biggest acquisition channel), one codebase for buyer/seller/admin |
| Backend | Node.js (NestJS) | Fast iteration, strong typing end-to-end, native hybrid support for GraphQL + gRPC + REST in one app (no separate gateway needed), good ecosystem for queues/workers |
| API — web | GraphQL (Apollo Server, code-first) | Flexible nested queries for dashboard UI; GraphQL Code Generator gives typed hooks straight into the Next.js app |
| API — native apps | gRPC (Protocol Buffers, HTTP/2) | Binary payloads, multiplexed connections, typed codegen for Swift/Kotlin — lowest-latency, most network-efficient option for mobile clients |
| CAD parsing worker | Python + Open CASCADE Technology (`pythonocc-core`), or a licensed CAD-exchange API | OCCT's CAD-kernel bindings are far more mature in Python than Node; isolates a CPU-heavy, slow (seconds–minutes) job from the request-latency-sensitive core |
| Database | PostgreSQL | Relational integrity matters (orders, licenses, leads, entitlements); JSONB for flexible per-category spec fields |
| Search | Elasticsearch/OpenSearch | Faceted search (category, specialty, certification, price band, location) is core to discovery |
| Cache/Queue | Redis + BullMQ | Lead distribution, notification fan-out, async doc verification jobs |
| Object storage | S3-compatible (AWS S3 / Cloudflare R2) | Product images, certs, IFU PDFs |
| Auth | Auth (custom JWT or Clerk/Auth0) + OTP (phone) | Indian B2B buyers trust phone/OTP more than email-only |
| Payments | Razorpay (India-first, supports UPI/NEFT/EMI for capital equipment) | Needed for Buy-Now path and subscription billing |
| Notifications | MSG91/Gupshup for SMS+WhatsApp, SES for email | WhatsApp is the dominant B2B comms channel in Indian trade |
| Infra | AWS or GCP, containerized (Docker), ECS/Cloud Run to start — no k8s yet | Avoid premature infra complexity |
| Observability | OpenTelemetry + Grafana/Datadog, Sentry for errors | |

---

## 6. Core data model (simplified)

```
Organization (buyer or seller company)
 ├─ id, name, gstin, type[buyer|seller], kyc_status
 ├─ licenses[]        # CDSCO reg no., type, expiry, doc_url
 └─ users[]           # role: admin|staff

Product
 ├─ id, org_id (seller), title, category_id, brand
 ├─ device_class       # CDSCO A/B/C/D, nullable for non-devices (consumables)
 ├─ specs (JSONB)       # category-specific attributes
 ├─ certifications[]    # ISO13485, CE, CDSCO reg, doc_url, expiry
 ├─ price_type          # quote_only | fixed | slab
 ├─ price / price_slabs
 ├─ images[], documents[] # IFU, datasheet, calibration cert template
 └─ service_addons[]    # installation, AMC, training — priced separately

Category (tree)          # e.g. Diagnostic Imaging > Ultrasound > Portable
 └─ attribute_schema     # defines which JSONB spec fields apply, drives search facets

RFQ (Request for Quote)
 ├─ id, buyer_org_id, product_id or category_id, quantity, specs_required
 ├─ status               # open | quoted | closed
 └─ quotes[]             # seller_org_id, price, validity, notes, doc attachments

Lead
 ├─ id, rfq_id or inquiry, seller_org_id, buyer_org_id
 ├─ source               # search_inquiry | rfq | catalog_contact
 └─ credit_cost, delivered_at, status

Order (Buy-Now path only)
 ├─ id, buyer_org_id, seller_org_id, line_items[], payment_status, shipment_status

Subscription
 ├─ org_id (seller), plan, lead_credits_remaining, renews_at
```

Design notes:
- `specs` as JSONB keyed against a per-category `attribute_schema` gives flexible, category-specific fields (e.g. "wavelength" for lasers, "cold chain required" for reagents) without a table-per-category explosion, while `attribute_schema` still lets the search service build correct facets.
- Licenses/certifications are **first-class entities with expiry**, not free text — enables automated re-verification reminders and search filters like "CDSCO registered only."

---

## 7. Core modules — MVP scope

1. **Auth & Org onboarding** — phone OTP + email, company profile, GSTIN capture (validate via GST API), document upload for KYC.
2. **Seller KYC/verification pipeline** — admin queue to review license docs before a seller can list Class C/D devices; auto-approve low-risk consumables sellers with lighter checks.
3. **Catalog management** — seller dashboard to create/edit products, bulk upload via CSV/Excel (critical for distributors with hundreds of SKUs — IndiaMart's sellers rely heavily on this).
4. **Category taxonomy** — curated tree covering major medical-instrument verticals (diagnostic imaging, surgical instruments, patient monitoring, lab equipment, disposables/consumables, orthopedic implants, dental, ophthalmic, etc.) with per-category spec schema.
5. **Search & discovery** — faceted search (category, device class, certification, brand, price band, location/state), SEO-indexable category and product pages.
6. **RFQ / inquiry engine** — buyer posts an RFQ (single product or "I need X, spec Y, qty Z"); matched sellers get notified; sellers submit quotes; buyer compares side-by-side.
7. **Lead distribution & credits** — map inquiries to seller lead-credit balance, deduct on delivery, notify seller (app + WhatsApp + email).
8. **Messaging** — buyer↔seller thread per RFQ/product inquiry, attachments support (for spec sheets, quotes).
9. **Seller subscription & billing** — plan selection, Razorpay integration, credit top-ups.
10. **Admin console** — category management, KYC approval queue, listing moderation, dispute flags.
11. **Buy-Now checkout** (consumables only) — cart, Razorpay payment, order tracking — scoped narrow in MVP (maybe deferred to post-MVP if it adds too much scope).

**Explicitly out of MVP scope**: service-partner marketplace (AMC/installation booking), financing/EMI integration, multi-language beyond English/Hindi, mobile native apps, international sellers/export compliance, escrow, CAD-to-sourcing (§7b, Phase 5).

---

## 7b. CAD-to-sourcing layer (Phase 5)

A buyer uploads a CAD assembly (a device or sub-assembly design); the platform extracts its components and recommends verified sellers per component. This is a distinct subsystem — different tech stack, different latency profile (seconds–minutes, always async), and its own build-vs-buy decision — not a feature bolted onto the core catalog.

**Pipeline:**
1. **Ingestion** — presigned multipart upload (resumable, tolerant of flaky mobile networks). MVP supports **neutral formats only: STEP/IGES**. Native formats (SolidWorks `.sldprt`, Fusion `.f3d`, etc.) need proprietary SDKs/licensing and are out of scope initially. STL is explicitly excluded — it's mesh-only geometry with no material/assembly/BOM metadata, so it can't support component identification.
2. **Parsing & feature extraction** — walk the assembly tree; extract per-part geometry (bounding box, volume, detected features like holes/threads) and any embedded BOM table. Reading a CAD file's own structured parts list is far more reliable than inferring "this is an M4 screw" from raw geometry alone.
3. **Component matching**:
   - Standard parts (screws, connectors, tubing, sensors with known specs) → direct lookup against the marketplace catalog/search.
   - Custom/non-standard machined parts → no SKU exists; route into the **existing RFQ engine** (§7 item 6) with extracted geometry/specs attached as quoting context. Reuses infrastructure instead of building a second sourcing flow.
4. **Seller recommendation** — rank candidate sellers per matched component on price, lead time, verified/certified status (ISO 13485 relevance for medical parts), and fulfillment history — the same trust signals the KYC/verification layer (§7 item 2) already tracks.
5. **Async delivery** — CAD parsing runs as a background job (queue → Python worker → push notification on completion), never in the request path. Poll or webhook the result back to web/native clients.

**Architecture consequence**: this is the one piece that justifies breaking out of the modular monolith described in §4. OCCT's CAD-kernel bindings are far better supported in Python than Node, so the CAD worker is a **separate Python service**, communicating with the NestJS core purely via the job queue (Redis/BullMQ or SQS) — not in-process. Everything else in the plan stays in the monolith.

**Build vs. buy (the decision that drives this phase's cost and timeline most):**
- **Build on OCCT** — full control, no per-file cost, but weeks-to-months of dedicated engineering before feature recognition is reliable. Geometric feature recognition (raw geometry → "this is a standard M4x12 screw") is a hard, mature-but-nontrivial problem — it's the core IP of companies like Xometry/Fictiv.
- **License a commercial CAD-exchange/feature-recognition API** — much faster to a working demo, ongoing per-file/API cost, less control over matching logic.
- **Recommendation**: start with the buy option to validate the feature works and drives sourcing behavior, revisit build-in-house only once volume justifies the investment.

---

## 8. Non-functional requirements

- **Compliance**: DPDP Act 2023 (India's data protection law) for any buyer/hospital PII; retain KYC docs per regulatory record-keeping norms; GST-compliant invoicing on Buy-Now orders.
- **Security**: standard OWASP hygiene, signed URLs for document access (certs/IFUs shouldn't be publicly guessable), role-based access control between org staff.
- **Performance**: category/product pages SSR + CDN-cached (public, cacheable); search p95 < 300ms; lead notification delivered < 1 min from inquiry.
- **Scale target for MVP**: design for ~5–10K sellers, ~200K products, ~50K MAU buyers — comfortably within a Postgres+ES modular monolith; no need for sharding or microservices at this scale.
- **Auditability**: every KYC approval, listing edit, and quote is logged (admin/dispute needs).

---

## 9. Phased roadmap

**Phase 0 — Foundations (2–3 wks)**
Repo setup, auth, org onboarding, base DB schema, category taxonomy design (this needs real domain research — pull from an actual medical-device classification reference, not guessed categories).

**Phase 1 — MVP core (6–8 wks)**
Catalog + bulk upload, search, RFQ engine, lead distribution, messaging, seller KYC pipeline, basic admin console, **English + Hindi UI and notifications** (§14). Launch with a **single seeded vertical** (e.g. diagnostic imaging or surgical instruments) rather than all categories at once, to validate the loop before breadth.

**Phase 2 — Monetization (3–4 wks)**
Subscription plans, lead credits, Razorpay billing, featured listings.

**Phase 3 — Trust & growth (4–6 wks)**
Verified Supplier badge, ratings/reviews, buyer-side saved searches & price alerts, WhatsApp-first notification flow, SEO content layer for category pages, **additional regional languages** (§14) prioritized by where seller/buyer signups actually concentrate.

**Phase 4 — Expansion**
Buy-Now consumables checkout, service-partner (AMC/installation) marketplace, additional categories, native mobile apps (this is when the gRPC transport in §4 actually gets a client).

**Phase 5 — CAD-to-sourcing**
CAD upload + parsing pipeline, component extraction, catalog/RFQ matching, seller recommendation ranking. See §7b for full design. Gated on Phase 1–2 validating the core marketplace loop first — this is a differentiator layered on proven demand, not a way to bootstrap it.

---

## 10. Key open decisions to confirm before build starts

1. **Buy-Now in MVP or deferred?** Adding checkout/payments to MVP roughly doubles early scope; recommend deferring to Phase 4 unless consumables revenue is the near-term priority.
2. **Which single category to launch first** — determines the taxonomy/spec-schema work in Phase 0.
3. **NestJS vs Django** for backend — NestJS recommended for TS type-sharing with Next.js frontend, but say if the team has stronger Django/Python skills.
4. **Self-hosted Elasticsearch/OpenSearch vs managed (Elastic Cloud/AWS OpenSearch Service)** — managed recommended at this stage to avoid ops overhead; deferred entirely at MVP in favor of Postgres full-text search (see §11).
5. **CAD parsing: build on OCCT vs license a commercial API** (§7b) — buy recommended for Phase 5 launch, revisit build later if volume justifies it.

---

## 11. Deployment & cost (MVP)

**Cheapest viable path to a real, demoable MVP — roughly $0–25/month**, stacking free tiers:

| Piece | Choice | Cost |
|---|---|---|
| Frontend | Vercel Hobby | Free |
| Backend | Render free web service (or Fly.io free allowance) | Free |
| Postgres | Neon or Supabase free tier | Free (0.5GB) |
| Redis/queues | Upstash free tier | Free |
| Search | Postgres full-text/trigram (`pg_trgm`) — no Elasticsearch at MVP | Free |
| Object storage | Cloudflare R2 | Free (10GB) |
| Domain | — | ~$10–15/yr |
| SMS/WhatsApp/email | MSG91 / SES, pay-as-you-go | ~$0 at low volume |

**Caveat**: free-tier backends/DBs spin down when idle (cold-start delay on first request) and cap storage low — fine for internal demos, not for onboarding real sellers with KYC documents. The moment real users are live, upgrade backend + DB to paid tiers (~$150–250/month on Render/Vercel).

**Path to AWS**: once past MVP validation, migrate to AWS (Mumbai region, `ap-south-1`) for India data residency and managed-service maturity — ECS Fargate (compute), RDS Postgres, ElastiCache Redis, S3 + CloudFront, OpenSearch Service only once faceted search at real scale is needed (it and NAT Gateway are the two line items that otherwise double the bill for no early benefit). CI/CD via GitHub Actions → ECR → ECS rolling deploy, infra defined in Terraform/CDK from day one. Growth-stage cost (~5–10K sellers, 50K MAU) lands around $600–1,200/month on either Render/Vercel or AWS — they converge in raw cost, but AWS offers Reserved Instances/Savings Plans and spot capacity that Render/Vercel don't, which is what makes the migration worth it once scale justifies the added ops surface.

---

## 12. Performance strategy (frontend & backend)

Two constraints matter more here than a generic "make it fast" checklist: **data cost** (users often pay per MB, or are capped) and **low-end device CPUs** (a lot of Indian traffic is Android Go / budget phones, where JS parsing/execution costs as much as download time). Frontend strategies (§12A) attack those two; backend strategies (§12B) attack server-side latency and throughput, since a fast browser still feels slow if the API behind it is sluggish.

### 12A. Frontend

**Reduce what gets sent**
- SSR/SSG/ISR (Next.js) over client-heavy SPA rendering — ship paintable HTML immediately.
- Route-level code splitting (default in Next.js) — buyers never download seller-dashboard JS and vice versa.
- Bundle-size auditing on every PR; avoid heavy libraries where a light one suffices.
- Brotli compression at the CDN/edge.
- **Respect the `Save-Data` header** — serve lower-res images, skip non-critical scripts (analytics, chat widgets), disable autoplay when present.
- Field-selective API queries — GraphQL field selection / gRPC field masks (§4) so list/catalog queries never over-fetch.

**Images**
- Next.js `<Image>` — responsive `srcset`, lazy loading below the fold.
- AVIF/WebP with JPEG fallback; multiple sizes generated at upload time, never send desktop-size images to mobile viewports.
- Blur-up (LQIP) placeholders so pages feel instant even on 2G.
- Lower quality automatically when `Save-Data` is present.

**Fonts & CSS**
- System font stack where acceptable; if a brand font is required, subset it and self-host with `font-display: swap`.
- Inline critical CSS, defer the rest.
- Prefer build-time CSS (Tailwind) over runtime CSS-in-JS — matters for low-end CPU execution cost, not just bytes.

**Edge delivery & repeat-visit speed**
- CDN with India PoPs (Mumbai/Chennai/Delhi) — cuts round-trip latency, which matters more than bandwidth on high-latency mobile networks.
- Long-lived immutable caching for hashed static assets; short/no-cache only for genuinely dynamic data.
- HTTP/2 or HTTP/3 (QUIC) — QUIC handles lossy mobile networks better than TCP-based HTTP/2.

**Perceived performance**
- Streaming SSR / React Server Components — send HTML progressively instead of waiting for the full render.
- Skeleton screens over spinners for catalog/search results.
- Optimistic UI for actions like "send inquiry."

**Low-end device (CPU, not just network)**
- Minimize main-thread JS/hydration cost — the strongest argument for leaning on SSR/RSC over client-heavy state.
- Virtualize long product-grid lists (`react-window`) instead of rendering thousands of DOM nodes.
- Debounce/throttle search-as-you-type.

**Third-party scripts**
- Audit every analytics/chat/ad tag; load `async`/`defer`, or lazy-load on interaction (e.g. chat widget only loads when "message seller" is clicked).
- Self-host where possible to avoid extra DNS/TLS handshakes to third-party origins.

**Client-side caching & prefetching (adaptive, not blind)**

"Prefetch aggressively" and "minimize data" only reconcile if prefetching is **network-aware**: prefetch freely on wifi/4G with no `Save-Data` flag, back off hard on 2G/3G or when Data Saver is on.

- *Route/code prefetch*: Next.js `<Link>` viewport-based prefetch (tune further, don't prefetch every link on a page); intent-based prefetch on hover/touchstart; predictive prefetch of the next results page once a user is ~70–80% scrolled.
- *Data prefetch/cache*: stale-while-revalidate via SWR/React Query/Apollo — instant render from cache, background refresh. Persist that cache in IndexedDB/Cache API (not just memory) so a returning user paints instantly from disk before any network call fires.
- *Cache-first service worker* for near-static data (category taxonomy, seller profiles, spec sheets) — revalidate periodically, not on every visit.
- *App-shell caching* — cache nav/header/footer once; navigations only fetch the content region.
- *HTTP cache headers as fallback* — ETag/`Last-Modified` so even a plain browser cache gets 304s instead of full re-downloads.
- *Persistent client-side state*: IndexedDB for recently viewed products, in-progress RFQ drafts, cart contents (survives dropped connections); localStorage for auth token/filters/UI prefs.
- *Network-aware gating*: use the Network Information API (`navigator.connection.effectiveType`, `.saveData`) to control how aggressively speculative prefetching runs; use `requestIdleCallback` so prefetch work never competes with active interaction for CPU/bandwidth.
- *Never prefetch large assets speculatively* — route JS and small JSON payloads prefetch freely; images/documents always load on demand regardless of connection quality.

Net effect targeted: a repeat visitor should feel almost entirely served from cache (instant category browsing, recently viewed, nav), while first visits and genuinely new data still respect the low-data/`Save-Data` constraints above.

**Frontend measurement (don't skip this)**
- Test against throttled 3G/Slow 4G profiles in CI (Lighthouse), not just on office wifi.
- Real User Monitoring on Core Web Vitals, segmented by connection type and region — India averages hide the tail that matters most.
- Performance budget enforced in CI (e.g. JS < 150KB gzipped/route, LCP < 2.5s on Slow 4G) so this doesn't regress silently as features get added.

### 12B. Backend

A fast, cached page still feels slow if the API behind it is sluggish — these strategies target server-side latency and throughput directly.

**Database & query performance**
- **Index deliberately**: B-tree on foreign keys and filter columns, GIN indexes on the `specs` JSONB column for per-category attribute filtering, trigram (`pg_trgm`) indexes to back MVP full-text search (§11).
- **Kill N+1 queries** — DataLoader batching on every GraphQL/gRPC resolver that touches a relation (e.g. product → seller org → certifications), not just the obvious ones.
- **Cursor-based pagination**, never offset-based, on any endpoint returning catalog/search/lead lists — offset pagination degrades linearly with table size and is a classic silent latency regression as data grows.
- **Connection pooling** (PgBouncer or RDS Proxy) — essential once the backend runs as multiple autoscaled containers, otherwise each task opening its own DB connections exhausts Postgres's connection limit under load.
- **Read replicas** for read-heavy catalog/search traffic once volume justifies it, keeping the write path (orders, RFQs, leads) on the primary — don't do this prematurely, it adds real operational complexity.
- **Materialized views or denormalized read models** for expensive aggregates (seller ratings, category product counts) computed on write instead of recalculated on every read.

**Caching (server-side)**
- **Redis cache-aside** for hot, slow-changing data: category taxonomy, popular product listings, computed search facets — TTL-based with explicit invalidation on write, not just expiry.
- **CDN edge caching** for public, cacheable GET responses (product/category pages via ISR) so repeat requests never reach the origin at all.
- **GraphQL Automatic Persisted Queries (APQ)** — client sends a query hash instead of full query text after the first request, cutting request payload size on every subsequent call.

**Request-path discipline**
- **Push everything non-critical off the request path** — lead notification fan-out, KYC document verification, email/SMS/WhatsApp sends all go through BullMQ (already in the plan for other reasons); the API response returns the moment the DB write is durable, not after every side effect completes.
- **Field-selective responses** — GraphQL field selection and gRPC field masks (§4) apply on the backend too: resolvers should avoid fetching/serializing fields the client didn't ask for, not just avoid over-fetching from the DB.
- **Response compression** (gzip/brotli) and **HTTP/2 keep-alive** on the API itself, not only static assets.
- **Rate limiting/backpressure** at the gateway layer — protects p95 latency for legitimate traffic from being dragged down by abusive or runaway clients (scraper bots hitting the catalog are a real risk for a public B2B directory).

**Search performance**
- Tune Elasticsearch/OpenSearch mappings deliberately (explicit field types, not dynamic mapping guesses); prefer filter context (cached, unscored) over query context for facet filters like category/certification/price-band.
- Cache results for common/repeated search queries (popular categories) in Redis ahead of hitting ES at all.

**Scaling & infra**
- Horizontal autoscaling on the ECS Fargate service (CPU/request-count triggers), sized against connection-pool limits so scaling out doesn't itself become the bottleneck.
- Deploy origin in the Mumbai region (§11) — cuts backend round-trip latency for the majority-India user base directly, independent of any caching strategy.

**Backend measurement (don't skip this either)**
- OpenTelemetry tracing (already in the stack, §5) wired to actually find slow resolvers/queries, not just left as unused instrumentation.
- Load test (k6 or Artillery) the RFQ and search endpoints specifically before launch — these are the two paths most likely to see real concurrent load (a popular RFQ or a trending search term).
- Track and alert on DB slow-query logs and p95/p99 API latency per endpoint, not just average latency — averages hide exactly the tail-latency problems that matter most under real traffic.

---

## 13. SEO strategy

Organic Google search is IndiaMart's single largest acquisition channel (§5 already cites this as the reason for choosing Next.js SSR over a client-only SPA) — for a B2B directory-style marketplace, category and product pages **are** the marketing funnel, not a nice-to-have. Core technical foundations below belong in **Phase 1**, not deferred: retrofitting URL structure or rendering strategy after Google has indexed thousands of pages means losing rankings during the migration, not just extra engineering work.

**Rendering & crawlability**
- SSR/SSG for every public product, category, and seller-profile page (Next.js, §5) — non-negotiable at marketplace scale; client-only rendering risks incomplete or delayed indexing across hundreds of thousands of pages.
- **Mobile-first indexing**: Google indexes the mobile version of a page as primary — this makes §12A's low-bandwidth/mobile performance work directly SEO-relevant, not just a UX concern.
- **Core Web Vitals are a direct ranking factor** — the LCP/CLS/INP targets in §12A's performance budget double as SEO requirements, not only conversion ones.

**URL structure & indexable surface**
- Clean, hierarchical, human-readable URLs (`/category/sub-category/product-slug`); stable slugs with 301 redirects on any rename — never let a slug change silently 404.
- **Seller storefront pages are public and indexable** — each verified seller gets a crawlable profile page, expanding total indexable surface area the same way IndiaMart's individual seller/product pages compound into search visibility.
- Canonical tags on any URL variant (filter/sort query params) to avoid duplicate-content penalties; `noindex` on thin or non-public routes (dashboards, RFQ threads, checkout, admin).

**Structured data**
- JSON-LD Schema.org markup on product pages (`Product`, `Offer`, `AggregateRating`), seller pages (`Organization`), and category pages (`BreadcrumbList`) — powers rich snippets (price, rating, availability) directly in Google results, which meaningfully lifts click-through rate for listing-style pages.

**Sitemaps & crawl budget**
- Dynamically generated XML sitemap index (segmented by category, given 200K+ products at scale), regenerated on product add/edit, submitted via Google Search Console.
- `robots.txt` excludes non-indexable routes explicitly; pagination handled with proper `rel=next/prev` or a crawlable fallback if using infinite scroll.

**Content depth**
- Category pages need real content beyond a product grid — buying guides, spec explainers, FAQ — thin listing-only pages rank poorly. This is already the Phase 3 "SEO content layer for category pages" item (§9); flagging here that it's not optional polish, it's load-bearing for ranking.
- Internal linking (related products, breadcrumbs, "sellers also viewed") improves crawlability and distributes page authority across the catalog.

**Metadata**
- Unique, data-driven title/meta description per product and category page (templated from real specs/category name, not generic boilerplate repeated across thousands of pages — duplicate meta content is a common large-catalog SEO failure).

**Internationalization (later)**
- When Hindi/regional-language content ships (Phase 3–4, §9), use `hreflang` tags per language variant to avoid duplicate-content penalties across language versions.

**Ongoing monitoring**
- Track indexed-page count vs. total pages and crawl errors in Google Search Console as a standing operational metric, not a one-time launch check — silent de-indexing of large catalog sections is a real and easy-to-miss failure mode.

---

## 14. Localization / local-language strategy

English-only would exclude most of the actual buyer/seller base outside metro areas — this is a first-class requirement, not a late-phase nicety, so English + Hindi ship in the MVP (§9 Phase 1), with additional regional languages added in Phase 3 based on where seller/buyer signups concentrate (candidates: Tamil, Telugu, Marathi, Gujarati, Bengali, Kannada).

**Routing**: path-based locales (`/hi/category/...`, `/ta/category/...`), not subdomains — simpler infra, and it consolidates SEO authority under one domain while still giving Google distinct, `hreflang`-linked indexable URLs per language (§13).

**Content has three layers, each translated differently — conflating them is the usual localization mistake:**
1. **UI chrome & platform-generated text** (nav, buttons, transactional emails) — professionally translated string files (ICU message format, e.g. `next-intl`), fully authoritative.
2. **Curated platform content** (category taxonomy, attribute labels, FAQs) — pre-translated as part of content ops, stored per-locale (translations table or per-locale JSONB) since it's structured and platform-owned.
3. **Seller-generated content** (product titles/descriptions) — **not machine-translated by default**. For medical instruments, a bad MT rendering of a spec or intended-use statement is a liability, not just an awkward sentence. Keep it in the seller's original language; an optional, clearly-labeled "machine-translated, for reference only" toggle can help buyers, but it's never authoritative.

**Cross-cutting technical implications:**
- **Fonts**: load only the active locale's script subset (Devanagari, Tamil, Telugu, etc.) at a time — a bundle covering every Indian script would defeat the font-subsetting strategy in §12A. Localization and low-bandwidth performance interact directly here.
- **Search**: Elasticsearch needs locale-aware analyzers (language-specific stemming/stop-words/tokenization) — English-tuned tokenization silently breaks relevance the moment queries arrive in Devanagari or Tamil script.
- **Notifications first, UI polish second**: most buyers/sellers actually read WhatsApp/SMS, not the dashboard. MSG91/Gupshup (§5) support localized templates — prioritize translating lead/RFQ notification templates before deep UI translation, since that's where the actual read-rate is.
- **SEO payoff**: localized, `hreflang`-linked pages are a genuine acquisition channel for local-language search queries from tier-2/3 cities, not just an accessibility feature (§13).

---

*Next step once these are confirmed: scaffold the repo (Next.js + NestJS monorepo, Postgres schema/migrations for Phase 0 entities) and start Phase 0.*
