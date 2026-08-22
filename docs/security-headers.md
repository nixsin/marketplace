# Security headers

CSP, HSTS, COOP and clickjacking headers: what is set, what is deliberately not, and why the CSP has no nonce.

Extracted from CLAUDE.md, which keeps a pointer here. Operating
rules live there; this file is the reference.

---

Added 2026-08-17 after a manual Lighthouse best-practices audit against the
deployed site found no CSP, no HSTS, no COOP, no clickjacking mitigation,
and no Trusted Types header on any real page — all scored "informative" so
none of it hurt the Lighthouse score itself, but they were real,
unaddressed gaps on a site that already handles seller/buyer accounts.
All four (minus Trusted Types, see below) are set via `headers()`'s
existing array, in a new block alongside the two pre-existing scoped
blocks (favicon caching, locale page Cache-Control) — this repo already
had a `headers()` function for those, extended rather than duplicated.

**Scoped to actual page/document responses, not literally every route —
the first version shipped as `source: "/(.*)"` and that was a real,
caught-live bug, not a style choice.** `headers()` applies before the
filesystem (per Next's own docs), so that matcher also applied CSP/HSTS/
XFO/COOP to every `/_next/static/*` chunk response — real header bytes on
every script request, identical across all 10 of `perf-budget.mjs`'s
runs on the CI run that caught it (not noise; JS transfer size is
deterministic, unlike LCP), pushing the JS budget over by ~1.4KB for zero
actual security benefit — none of these headers do anything on a
sub-resource's own response, only on the document that establishes them.
Fixed to `source: "/((?!_next|favicon\\.ico).*)"` — same negative-
lookahead style `src/proxy.ts`'s own matcher already uses in this repo,
confirmed to compile the same way here (both go through Next's identical
path-to-regexp matcher). Verified directly post-fix: a real page response
still carries all four headers, a real static chunk carries none of them,
and `perf-budget.mjs`'s JS-transfer measurement dropped back to 189.0KB
(budget 191KB).

**The actual header-value computation lives in `src/lib/security-
headers.ts`, not inline in `next.config.ts`** — pulled out specifically
because an `ai-code-review` pass flagged (twice, across two pushes to the
same PR) that the manual `curl`/browser verification documented below
isn't repeatable regression coverage for security-critical, environment-
dependent logic (dev-vs-prod CSP directives, the API-origin
interpolation). `next.config.ts` can't easily be imported and exercised
by a normal test the way most code can — it's the file Next.js itself
loads to boot — so the fix is the same "pull pure logic into a tested
module" pattern already established elsewhere in this repo
(`pr-reconciliation.mjs`, `review-verdict.mjs`, `ci-progress-comment.mjs`):
`buildCspHeader({ isDev, apiUrl })` and `computeApiOrigin` are now plain,
unit-tested functions (`security-headers.spec.ts`), and `next.config.ts`
just wires their output into `headers()`. Needed a small, deliberate
`vitest.config.ts` change too — its `include` glob only ever matched
`src/**/*.spec.tsx` (component tests) and `test/**/*.spec.ts`, neither of
which fit a plain-logic module under `src/lib/`; widened to also match
`src/**/*.spec.ts`.

**CSP is the static, no-nonce form — deliberately, not as a shortcut.**
Next's own docs (`node_modules/next/dist/docs/01-app/02-guides/content-
security-policy.md` for this exact version — see `apps/web/AGENTS.md`,
this is the kind of thing that's genuinely changed release to release, and
did: this Next version renamed `middleware.js` to `proxy.js` entirely,
confirmed directly in that same doc tree rather than assumed from training
data) recommend a nonce-based CSP as the stricter option, generated
per-request in `proxy.ts` (this repo already has one, for next-intl's
locale routing — see its own file). But nonces require **every page to
render dynamically** — Next can only inject a nonce during SSR, so a page
prerendered at build time has nowhere to put it. That's a direct conflict
with this repo's own existing, deliberate architecture:
`product-listing.tsx`'s own comment explains the page shell is kept
statically prerenderable specifically so it stays browser-cacheable (see
also the `/(en|hi)` Cache-Control block already in this same file), with
product data fetched client-side for exactly that reason. Going nonce-based
would mean giving that up. Used Next's own documented "Without Nonces"
pattern instead: a fixed CSP header value in `next.config.ts`, no `proxy.ts`
involvement at all. Trade-off, stated plainly: `'unsafe-inline'` is
required for both `script-src` (Next's inline hydration `self.__next_f...`
scripts) and `style-src` (the inline `style` attributes both React and
`next/image` emit, e.g. `next/image`'s `fill` positioning) — real, not
full, XSS hardening. Still meaningfully blocks external script injection,
clickjacking (`frame-ancestors 'none'`), mixed content, and base/form-
action hijacking. Revisit with nonces if this app ever needs dynamic
rendering anyway (e.g. a real auth-gated page — there's no login/onboarding
UI yet per the Web e2e section above).

**`connect-src` is derived from `NEXT_PUBLIC_API_URL`, not hardcoded** —
`new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/graphql").origin`,
the identical fallback `src/lib/api.ts` already uses. Verified directly
(not assumed) that `next.config.ts` can read this at all: Next's own
`loadEnvConfig` call happens before the config file is even located,
confirmed by reading `next/dist/server/config.js` directly — so `.env.local`
values are already in `process.env` by the time this module's top-level
code runs. This is what lets the same CSP work correctly against a local
API in dev and `medinstru-api.onrender.com` in prod without a separate
dev/prod branch for this specific directive.

**`upgrade-insecure-requests` is prod-only** (`isDev` gate, same variable
already gating `'unsafe-eval'` per Next's own documented dev-mode
requirement) — deliberately, not just to mirror the eval gate. It upgrades
any `http:` sub-resource URL a page references to `https:`, including
fetch/XHR targets governed by `connect-src`; in dev, that directive's value
is `http://localhost:4000` (from `.env.local`), and forcing that to
`https://localhost:4000` would break every local GraphQL call against a
plain-HTTP local API server. Whether `localhost` is actually exempt from
this upgrade in practice wasn't verified either way — the `isDev` gate
sidesteps needing to know, at zero real cost (the directive's actual
purpose is protecting a deployed HTTPS origin from accidentally serving
mixed content, which doesn't apply to local dev regardless).

**Verified directly, not assumed**: header values via `curl -sD -` against
both a real `next dev` server and a real `next start` (production) build on
a separate port — confirmed dev mode carries `'unsafe-eval'` and omits
`upgrade-insecure-requests`, prod mode is the reverse, and both carry the
right `connect-src` origin. Then loaded the dev server in a real browser
and confirmed zero CSP violations in the console — the only errors present
were plain `net::ERR_CONNECTION_REFUSED` / "Failed to fetch" against the
local API (which wasn't running in that session), not the distinctly-
different "Refused to connect... violates the following Content Security
Policy directive" message Chrome emits for an actual CSP block. A full
Docker-based local stack (Postgres + API) wasn't spun up to verify an
actual successful cross-origin fetch end-to-end — the `connect-src` origin
is verified by construction (same source as `src/lib/api.ts`'s own env var)
rather than by a live successful call.

**`X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` were
absent until 2026-08-21, and their absence was an oversight rather than a
decision.** Worth recording precisely because this file already documents two
*deliberate* omissions with reasons -- HSTS `preload` and Trusted Types -- so a
reader could reasonably have assumed anything missing had been considered.
These three had zero mentions anywhere in the repo: not here, not in
`next.config.ts`, not in `@medinstru/config`. Nothing failed while they were
absent, and they were found by auditing live production responses rather than
by reading the code. `security-headers.spec.ts` now asserts the full header
list, so a future removal fails a test instead of waiting for another audit.

`Permissions-Policy` denies every powerful feature with an empty allowlist.
That is safe rather than aggressive: `apps/web/src` was grepped for
`geolocation`, `camera`, `microphone`, `getUserMedia`, `payment` and
`navigator.usb`, all zero hits. `Referrer-Policy` is set to
`strict-origin-when-cross-origin`, which is what browsers already default to --
declared so the behaviour is a decision rather than an inherited default that a
future browser release could change underneath us.

**HSTS omits `preload` deliberately** — `max-age=63072000; includeSubDomains`
only. Submitting to the HSTS preload list is effectively irreversible
(baked into browser binaries), so it's being deferred until this header has
run in production for a while, not added reflexively alongside the rest.

**Trusted Types (`require-trusted-types-for 'script'`) is a known,
deliberate gap, not an oversight** — Lighthouse's best-practices audit
flags its absence, but it wasn't added: it requires declaring a policy name
that matches whatever Next.js's own internals actually register under (if
any), and getting that wrong fails *silently* — a blocked DOM write, not a
loud error — which isn't something this pass could verify without
exhaustive live testing across every page and interaction. Confirmed there's
no `dangerouslySetInnerHTML` and no `<form>` anywhere in `apps/web/src`
(grepped directly), which lowers the app's own risk surface for this, but
that alone isn't the same as confirming compatibility with Next's internals.
Revisit only once actually verified against a real, confirmed Trusted Types
policy name for this Next.js version — not before.
