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
Postgres remains fully Terraform-managed on `free` and retains the documented
expiry risk.

The Render owner (`tea-da02feht0dsc738nmfv0`) and production project
environment (`evm-da02hptg1s2s73c6e7tg`) are non-secret stable identifiers and
are declared in the stack so imports and plans do not depend on an extra shell
variable or detach Postgres from its existing project environment.

Do not activate `render.yaml` Blueprint sync while Terraform owns the same
resources.

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
