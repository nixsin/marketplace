# Render + Cloudflare Terraform

The stacks deliberately have separate state:

- `render/` adopts the existing Render Postgres database and Docker services.
- `cloudflare/` adopts the existing `laxair.shop` DNS records, R2 bucket, and
  zone cache-settings ruleset.

No stack is applied automatically. Existing resources must be imported first;
an unimported apply can create duplicates or conflict with live resources.

## Correction from the abandoned AWS draft

The preceding implementation mistakenly interpreted “Cloudfront” as AWS
CloudFront instead of this project's existing Cloudflare setup. Its statement
that two CloudFront distributions “already exist” was itself part of that
mistake—it was written without AWS credentials or evidence. On 2026-08-20 the
repository owner explicitly confirmed they do not have an AWS account. No AWS
credentials were configured, no apply/import ran, and a filesystem check found
no Terraform state. Removing `cloudfront/` therefore removes dead HCL only;
there is no AWS infrastructure, account, or state to migrate or destroy.

## Prerequisites

- Terraform 1.9+
- `RENDER_API_KEY` for Render
- `CLOUDFLARE_API_TOKEN` with Zone Read, DNS Read/Edit, Cache Rules Read/Edit,
  and Workers R2 Storage Read/Edit for this account and zone
- Access to the `nixsin-marketplace` HCP Terraform organization. The stacks
  store state in separate `marketplace-render-production` and
  `marketplace-cloudflare-production` workspaces; state contains sensitive
  Render connection data and must never be committed.

## Adopt Render

```bash
export TF_VAR_jwt_secret='<existing Render JWT_SECRET>'
cd infra/terraform/render
terraform init
terraform import render_postgres.main dpg-da02hq7lk1mc73f01hkg-a
terraform import render_web_service.api srv-da02lnojo6nc73djh9bg
terraform import render_web_service.web srv-da02mt61egvs73fopb00
terraform plan
```

The `/default` suffix is intentional: the pinned Cloudflare provider v5.23
documents the R2 import ID as
`<account_id>/<bucket_name>/<jurisdiction>`. Do not shorten it to a two-part
identifier.

The provider cannot represent Render's legacy free web plan. More importantly,
provider v1.9.1 echoes the computed `maintenance_mode` object during every
service update, while Render rejects that field for free services. Both
imported web services therefore use `ignore_changes = all`: Terraform records
their identities and blocks planned destruction, but their live settings remain
dashboard/API-managed until they are upgraded or the provider is fixed. A
read-only data lookup guards each resource, so deletion outside Terraform makes
planning fail before Terraform can propose recreating it. Recovery is manual:
restore or recreate the service in Render, update its stable ID if necessary,
and update the declarative import ID if it changed before planning again.
Permanent `import` blocks also make a fresh or recovered empty HCP state adopt
the stable production objects instead of planning duplicates.
Postgres remains Terraform-managed on `free` and retains the documented
expiry risk -- with the explicit exception of the five ignored attributes
described below, which stay dashboard/API-managed.

`render_postgres` has six optional-computed attributes, and provider v1.9.1
clears any one the configuration omits -- that is what wiped the allow-list on
the first apply. `ip_allow_list` is now declared and asserted; the remaining
five (`database_name`, `database_user`, `disk_size_gb`,
`high_availability_enabled`, `log_stream_override`) are listed in
`ignore_changes` so Terraform plans them from prior state rather than null.
They are ignored rather than declared because the live database name and user
are readable only from the connection secret, and declaring a wrong value
would plan a replacement of the production database. To manage one later,
read its live value first, declare it explicitly, and remove it from the
ignore list -- one at a time.

Postgres explicitly retains the live `0.0.0.0/0` IP allow-list because GitHub
Actions reaches its external endpoint to apply production migrations. Provider
v1.9.1 cleared the imported rule when the optional-computed field was omitted,
so never remove it without first replacing the CI database-access mechanism.
This preserves the existing password-authenticated, TLS-protected posture but
still exposes the endpoint to internet scanning. Narrowing it requires moving
migrations to a stable-egress/self-hosted runner or a private Render-side job;
GitHub-hosted runners do not provide one stable address to allow-list.

The Render owner (`tea-da02feht0dsc738nmfv0`) and production project
environment (`evm-da02hptg1s2s73c6e7tg`) are non-secret stable identifiers and
are declared in the stack so imports and plans do not depend on an extra shell
variable or detach Postgres from its existing project environment.

Do not activate `render.yaml` Blueprint sync while Terraform owns the same
resources.

## The API cache (Render Key Value)

`enable_key_value` is **on and free**. Render's Key Value has a free plan --
25 MB, one active instance per workspace -- so the defaults cost nothing.
Applying creates three things: the instance, an env group carrying `REDIS_URL`,
and the link attaching that group to the API service.

```bash
cd infra/terraform/render
terraform apply
```

That is the entire operation. There is no dashboard step, and **nobody handles
the credential**: Terraform reads
`connection_info.internal_connection_string` straight off the Key Value
resource into the env group, so it is never typed, pasted, or in a shell
history. The *internal* string, not the external one -- both services sit in
the same Render environment, which keeps the traffic off the public network.

An env group rather than `env_vars` on the service, because
`render_web_service.api` carries `ignore_changes = all` (see above): setting it
on the service would be silently dropped.

### Free means no persistence, and that is safe here

Render documents that persistence is unavailable on free Key Value, and that a
free instance loses all of its data whenever it restarts. So
`key_value_persistence_mode` defaults to `off`; sending `journal_snapshot` on
`free` is the documented shape of a refused apply. The two settings are coupled
by the plan -- raise them together or not at all.

Data loss on restart cannot produce a wrong answer, for a structural reason
rather than a tolerance for risk: the catalogue version lives in **Postgres**
(`CacheVersion`), and Redis only ever holds values *addressed by* that version.
An emptied instance can only miss, and a miss is the null-cache path the API
already runs on. What `off` gives up is the warm cache after a restart -- one
`COUNT(*)` against a small table, at today's catalogue size.

Note this free plan is **not** the free-Postgres situation. Free Postgres
expires 30 days after creation; free Key Value carries no such clock.

### Turning it off again is not symmetric

`render_keyvalue.cache` has `prevent_destroy = true`, so once the instance
exists, setting `enable_key_value = false` does **not** quietly remove it --
Terraform refuses the plan with `Instance cannot be destroyed`. That is the
intended protection, and it is asserted from a clean state in
`main.tftest.hcl` (`cache_gating_is_all_or_nothing`) precisely because the
obvious test ordering hides it. Removing a live cache is a deliberate act:
drop the lifecycle block in the same change that removes the resource.

### Verifying it connected

**A healthy cache logs nothing.** `RedisCacheStore` tracks health as a *state*
and logs only on transition, initialised healthy -- so there is no "connected"
line to look for. The signal is the *absence* of
`cache unavailable — serving every read from the database` in the API's Render
logs after the redeploy. For positive confirmation, the instance's own
dashboard shows keys once the catalogue is hit.

## The environment contract (`medinstru-app-env`)

`packages/config/src/env-contract.js` requires **every environment to declare
every variable**, and a deployment missing one refuses to boot rather than
running misconfigured. Render had five of the fourteen. `render_env_group.app_env`
supplies the rest and is linked to **both** services.

```bash
cd infra/terraform/render
terraform apply
```

Everything defaults to a value that is correct for a deployment with no
optional services configured, so a bare `apply` is enough:

| Variable | Default | What it means |
|---|---|---|
| `APP_ENV` | `render` | stated outright rather than inferred |
| `INQUIRY_TRUST_PROXY_HEADERS` | `false` | no header is trusted |
| `BLOB_PROVIDER` | `local` | see below |
| `WHATSAPP_ALLOW_FREE_FORM` | `false` | template-only, as Meta requires |
| everything else | empty | a documented "off" state, never a gap |

**Empty is a value, not an omission.** The contract distinguishes `undefined`
(somebody forgot) from `""` (a documented off state) — so each empty entry
above is a decision, and every one is described on its variable in
`variables.tf`.

### Turning something on

Supply it at apply time; never commit one:

```bash
export TF_VAR_inquiry_ip_hash_secret="$(openssl rand -hex 24)"
terraform apply
```

The same pattern covers `sourcemap_signing_key`, `blob_access_key_id`,
`blob_secret_access_key` and `whatsapp_access_token`. All five are
`sensitive = true` with an empty default, and
`scripts/terraform-env-drift.test.mjs` fails if any gains a committed value.

A value set by hand on the service takes precedence over an env group, so the
dashboard remains available for anything you would rather not route through
Terraform at all.

### `BLOB_PROVIDER=local` is permitted here

The invariant is *never write data to storage the CDN does not serve*, which
`local` violates only when something **writes**. Nothing in the app injects
`BLOB_STORE` yet, so refusing at boot would block a deploy over a capability
with no call sites. `LocalBlobStore.put()` throws on a deployment instead,
naming this variable, at the moment an upload is first attempted.

### The env group must be in the SERVICES' environment

Render refuses a link across that boundary:

```
Error: Unable to add service to environment group
  service must be in the same environment as the environment group
```

The group was created in `var.environment_id`
(`evm-da02hptg1s2s73c6e7tg`, where Postgres and the Key Value instance live)
while **both web services are in no project environment at all** — confirmed
from state: `{"api":null,"web":null}`. So `environment_id` is now derived from
the API service rather than hardcoded, which is null today and follows
automatically if the services are ever moved into an environment. A
`precondition` asserts both services share one environment, since otherwise a
single group cannot serve them.

Worth recording that the first diagnosis was wrong: the same error was read as
two links racing on one service, and `REDIS_URL` was consolidated into one
group on that basis. One group is still the right shape — it removes the
undocumented question of which group wins when two define the same key — but
it was not the fix, and the second apply failed identically.

The credential is still never handled by a person: Terraform reads the
**internal** connection string straight off the Key Value resource, so the
traffic also stays off the public network. With `enable_key_value = false`,
the same key is declared empty, which the contract reads as "no shared cache"
rather than "forgotten".

### `parameter_overrides` must be null on a free database

Render refuses the field for being **present**, not for being non-empty:
*"parameter overrides are not available on free tier databases"*. Passing an
empty map still sends the attribute, so the apply failed with the variable at
its default. It is `null` when empty now.

Worth noting how that was found: `terraform validate` and `plan` both accept
the empty map, because this is Render's constraint rather than the provider
schema's. Same shape as the `persistence_mode` lesson above — a provider
accepting a value is not the platform accepting it.

### What keeps this in step

Terraform cannot import the contract, so two tests do it instead:
`main.tftest.hcl` pins the group's contents and its link to both services, and
`scripts/terraform-env-drift.test.mjs` (in `test-ci-scripts`) compares the
group against `packages/config` in both directions — a contract variable
missing from Terraform, and a Terraform variable no app reads.

## Adopt Cloudflare

Create the scoped API token in Cloudflare, export it without writing it to a
file, then discover the live identifiers:

```bash
export CLOUDFLARE_API_TOKEN='<scoped token>'
scripts/cloudflare-terraform-ids.sh
```

Copy `cloudflare/terraform.tfvars.example` to the ignored
`cloudflare/terraform.tfvars` and set the reported `zone_id`. Initialize and
import the resources using the IDs printed by the script:

```bash
cd infra/terraform/cloudflare
terraform init
terraform import cloudflare_dns_record.web '<zone_id>/<apex_record_id>'
terraform import cloudflare_dns_record.www '<zone_id>/<www_record_id>'
terraform import cloudflare_dns_record.api '<zone_id>/<api_record_id>'
terraform import cloudflare_r2_bucket.media \
  'e922aa08db001f9e90a323fc6765e529/medinstru-media/default'
terraform plan
```

The expected Render plan after import is `No changes`. Do not remove the
service-wide lifecycle ignore, existence guard, or declarative import merely to
make a desired setting change: provider v1.9.1 will fail the update after
partially applying unrelated resources.

Cache rules require a separate safety step because one Terraform ruleset owns
the entire phase. Inspect the script's `cache_ruleset_rules_json` output, copy
every unrelated rule into `additional_cache_rules`, then set both
`adopt_cache_ruleset=true` and `cache_ruleset_inventory_confirmed=true`.
Only then import it:

```bash
terraform import 'cloudflare_ruleset.cache_settings[0]' \
  'zones/<zone_id>/<cache_ruleset_id>'
terraform plan
```

If discovery reports `cache_ruleset_id=not-created`, the same confirmation is
still required before enabling management; the first reviewed apply then
creates it. With the adoption flag left at its safe default (`false`), normal
plans cannot modify or delete dashboard cache rules.

### Verified live on 2026-08-21 -- HTML caching works

**The `Set-Cookie` risk this section used to warn about did not materialise.**
It was investigated by experiment after the rules went live, and the warning
was wrong. Recorded here because the mechanism is genuinely non-obvious and
would otherwise be re-derived from the same wrong starting point.

Measured after `terraform apply`:

| Request | Result |
|---|---|
| `en` browser -> `/en` | MISS then **HIT** |
| `hi` browser -> `/hi` | MISS then **HIT** |
| `hi` browser -> `/en` | **HIT** |
| session-bearing `/en` | not cached |
| bare root `/` | not cached |
| `Authorization` header | not cached |
| `/en` to a Hindi browser | still `lang="en"` |
| `/hi` to an English browser | still `lang="hi"` |

**Why the cookie does not block it.** next-intl does not set `NEXT_LOCALE` on
every response. From `middleware/syncCookie.js` in the installed package, it
writes the cookie only when it actually needs to change something:

```js
if (hasCookie && cookieValue !== locale)                 // outdated -> write
else if (!hasCookie && acceptLanguageLocale !== locale)  // disagrees -> write
// otherwise: no Set-Cookie at all
```

A normal browser viewing the locale its own `Accept-Language` already implies
falls into neither branch, so the response carries no `Set-Cookie` and is
cacheable. Once any such request populates the edge, every later visitor gets
a `HIT` -- including the ones that would individually have set a cookie.

**`localeCookie: false` is not needed.** It is a real option in next-intl
4.13.6 and would work, but it costs bare-root language memory for no gain.
Do not reach for it on the strength of a single `BYPASS`.

**How to mislead yourself here, since it happened.** `curl` sends no
`Accept-Language` header at all, which no browser does. That is the
pathological case: the resolved locale disagrees with a non-existent
preference, so next-intl writes the cookie, Cloudflare refuses to cache a
`Set-Cookie` response, and every probe reports `BYPASS`. Diagnosing cache
behaviour with a bare `curl` therefore reproduces a failure real traffic never
sees. Always pass a realistic `Accept-Language`.

### Re-verifying later

Use a real GET, never `curl -I` -- `-I` sends `HEAD`, and both HTML rules are
method-gated, so a `HEAD` probe takes the bypass every time and reports
`DYNAMIC` whether or not the rule works.

```bash
for i in 1 2; do for p in /en /hi; do
  printf '%s ' "$p"
  curl -sS -D - -o /dev/null -H 'Accept-Language: en-US,en' "https://laxair.shop$p" \
    | grep -i cf-cache-status
done; done
```

Judge the second pass. Then confirm it is still *narrow*, which matters more
than the hit rate:

```bash
# A session-bearing request must never be served from cache.
curl -sS -D - -o /dev/null -H 'Accept-Language: en-US,en' \
  -H 'Cookie: mi_sid=fake-session' https://laxair.shop/en | grep -i cf-cache-status

# Each locale keeps its own entry -- the URL is in the cache key.
curl -sS -H 'Accept-Language: hi-IN,hi' https://laxair.shop/en | grep -o 'lang="[a-z]*"'
```

### What the managed ruleset contains, and why order matters

**Five managed additions, appended after whatever you inventoried.** The
authoritative ruleset is `additional_cache_rules` (every unrelated dashboard
rule you copied in during adoption) followed by the five below, so the live
ruleset is larger than five whenever the inventory is non-empty -- the test
fixture supplies two inventoried rules and therefore asserts a total of seven.
Count the inventory in when reviewing a plan.

Order within the managed five is fixed. Cloudflare evaluates **every** matching
rule in sequence and the last match wins, so the three bypasses must stay last
-- a bypass placed before its own eligibility rule is silently overridden by
it, with no error anywhere. Tests assert the relative order of both eligibility
/ bypass pairs, and that the root bypass follows the inventoried rules.

| # | ref | Effect |
|---|-----|--------|
| 1 | `cache-public-graphql-gets` | Anonymous, cookieless `GET /graphql` becomes cache-eligible |
| 2 | `cache-public-html` | Anonymous page HTML on the apex host becomes cache-eligible |
| 3 | `bypass-authenticated-web` | Any web request carrying a session is never cached |
| 4 | `bypass-locale-negotiated-paths` | Every locale-negotiated path is never cached, unconditionally |
| 5 | `bypass-all-other-api-requests` | Every other API request is never cached |

**"Matches no managed rule" is not "is not cached."** Inventoried rules are
concatenated *before* the managed ones and the last match wins, so excluding
`/` from the two path-scoped HTML rules is not enough on its own -- an
imported dashboard rule broad enough to cover the apex would leave `/`
cache-eligible with nothing after it to say otherwise. Rule 4 exists for that
reason and is deliberately unconditional: no method, cookie or header test,
because a plain anonymous `GET /` is precisely the request such a rule would
leave eligible. The test fixture models this with a broad apex rule.

**Rule 4 covers every negotiated path, not just `/`.** The set is defined by
`apps/web/src/proxy.ts`'s matcher: any path with no dot in it, outside
`api`/`_next`/`_vercel`, passes through next-intl and is answered with a
redirect chosen from `NEXT_LOCALE` and `Accept-Language`. `/products`, `/foo`
and `/about` negotiate exactly as `/` does.

It started as a root-only rule, and that was too narrow. Those other paths were
uncached **only because next-intl happens to set a cookie on their responses** --
an accident, not a guarantee. Setting `localeCookie: false`, which this file at
one point recommended for cache hit rate, would have removed the accident and
silently begun serving the first visitor's language to everyone. The rule now
states the requirement rather than relying on a side effect.

The locale list comes from a Terraform `locales` variable, and
`scripts/cloudflare-locale-drift.test.mjs` fails the build if it diverges from
`LOCALES` in `packages/config`. Drift is silent in both directions: a locale
added only to the app stops caching, and one removed only from the app turns its
paths into shared-cacheable negotiated redirects.

Both eligibility rules use `respect_origin` for edge **and** browser TTL, so
every TTL lives in the application rather than split between code and
dashboard. Browser TTL is explicit rather than omitted because omitting it
falls through to the zone-level Browser Cache TTL default of 4 hours, which
once overrode the origin's `max-age=0` and left browsers holding stale API
responses. On HTML the same mistake would pin a whole page.

**The two cookie tests are deliberately different, and copying one onto the
other breaks it.** The API rules bypass on *any* cookie, which is right there:
every GraphQL read is anonymous and sent with `credentials: "omit"`, so a
cookie arriving at all means something unexpected. HTML cannot use that test
-- next-intl's middleware sets `NEXT_LOCALE` on every page response, so every
returning visitor carries a cookie and nothing would ever cache. HTML
therefore keys on `mi_sid`, the session cookie, alone -- read through
`http.request.cookies`, the parsed cookie map, never
`http.request.headers["cookie"]`. The raw header is wrong twice over: `[0]`
inspects only the first Cookie line while HTTP/2 permits splitting Cookie
across several (a session in a later line reads as anonymous, so eligibility
matches *and* the bypass misses -- authenticated HTML in a shared cache), and
a `contains` test would match a cookie merely named `xmi_sid`. `NEXT_LOCALE` is safe
to cache because it is derived purely from the URL (`/en` sets `en`, `/hi`
sets `hi`) and the URL is already part of the cache key, so a cached response
always carries the locale its own path implies.

**The bare root `/` is excluded from both rules**, and this one is not
belt-and-braces. `GET /` is a 307 whose `Location` is negotiated from the
`NEXT_LOCALE` cookie and `Accept-Language` -- measured directly: `en-US` yields
`/en`, `hi-IN` yields `/hi`, and the cookie overrides both. Neither input is in
the cache key, and the response carries no `Vary` to say so. It also carries
`set-cookie: NEXT_LOCALE`, so a cached root would not merely redirect the wrong
way -- it would **pin the wrong locale into other visitors' browsers**
persistently. Today the response has no `Cache-Control` at all, so
`respect_origin` bypasses it regardless; that is not a reason to leave it
matched, because resting correctness on the *absence* of a header is the same
trap this repo hit with GraphQL errors. Excluding it costs nothing -- `/` is a
redirect, not a rendered page -- while `/en` and `/hi` still cache.

An `Authorization` header disqualifies a request on the same footing as
`mi_sid`, matching what the API eligibility rule already does. Browsers do not
send it on a normal page load, so this is defence in depth -- until the site
sits behind HTTP Basic auth for staging protection, when every request carries
it and protected HTML would otherwise land in a shared cache.

`/_next/` is excluded because Cloudflare's default extension-based caching
already serves those as `HIT`; a rule here would only compete with it. **The
exclusion is repeated on the bypass**, and leaving it off was a real bug: a
logged-in browser sends `mi_sid` on every same-origin request, so a host-wide
bypass strips edge caching from content-hashed immutable assets that are
byte-identical for every user. With both exclusions present the pair is an
exact complement over the HTML path scope, and `/_next/` and `/sw.js` match
*neither* rule -- falling through to Cloudflare's defaults, as intended.
`/sw.js` is excluded belt-and-braces -- it already ships `no-store`, and a
stale service-worker script caused a live outage on 2026-08-21 by pinning a
CSP that named a retired API host.

### This codifies the HTML rule; it does not apply it

`adopt_cache_ruleset` still defaults to `false`, so merging this changes
nothing in production. Until the phase is inventoried and both flags are set,
the ruleset resource is not created and page HTML keeps serving `DYNAMIC`.

The `cloudflare_r2_custom_domain` resource does not support import in provider
v5.23. Because `images.laxair.shop` already exists, Terraform deliberately
does not declare it; it remains dashboard-managed rather than attempting a
conflicting create.

### Safety properties

- The apex, `www`, and `api` CNAMEs point at Render and are proxied.
- Only `GET /graphql` on `api.laxair.shop` is made cache-eligible.
- Requests carrying `Authorization` or `Cookie` are excluded.
- A final explicit bypass rule disables caching for credentialed, cookied, or
  non-GET GraphQL traffic, non-canonical paths, and every other API endpoint,
  even if an earlier imported dashboard rule is broad.
- Edge and browser TTLs respect the origin's headers. GraphQL errors retain
  Apollo's `no-store` and are not cached.
- R2 and all three DNS records have `prevent_destroy` protection.
- A ruleset resource owns its entire phase. If the imported live ruleset has
  additional rules, add them to `additional_cache_rules` before enabling its
  explicit adoption gate or Terraform will remove them.

Run validation without credentials or live changes:

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/render validate
terraform -chdir=infra/terraform/cloudflare validate
terraform -chdir=infra/terraform/cloudflare test
node --test scripts/cloudflare-terraform-ids.test.mjs
```
