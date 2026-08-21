# Render + CloudFront Terraform

The two stacks deliberately have separate state:

- `render/` owns the Render Postgres database and Docker web services.
- `cloudfront/` owns two AWS CloudFront distributions using the Render
  services' `*.onrender.com` hostnames as origins.

Keeping them separate lets CloudFront be planned and rolled out without
Terraform first adopting the already-live Render resources.

## Prerequisites

- Terraform 1.9+
- `RENDER_API_KEY` for the Render provider
- AWS credentials for the CloudFront stack
- ACM certificates in `us-east-1` before custom CloudFront aliases are set
- A remote Terraform backend configured by the operator; state can contain
  Render database connection data and must not be committed

## Adopt the existing Render resources

The resources already exist, so **import before apply**. Applying without
imports attempts to create duplicates.

```bash
cd infra/terraform/render
terraform init
terraform import render_postgres.main dpg-da02hq7lk1mc73f01hkg-a
terraform import render_web_service.api srv-da02lnojo6nc73djh9bg
terraform import render_web_service.web srv-da02mt61egvs73fopb00
terraform plan
```

Set the existing production secret without writing it to a file:

```bash
export TF_VAR_jwt_secret='<existing Render JWT_SECRET>'
```

Render's Terraform provider does not accept the legacy `free` plan for web
services. The configuration therefore uses a schema-valid `starter`
placeholder and explicitly ignores `plan` on imported web services. Terraform
will not upgrade them accidentally; plan changes remain a deliberate Render
dashboard operation until the services leave the legacy free tier. Postgres
still supports `free`, though the repository's documented expiry warning
still applies.

Do not manage the same resources from an active Render Blueprint and
Terraform simultaneously. `render.yaml` remains documentation until the
Terraform adoption is explicitly completed.

## Create and test CloudFront

These distributions already exist too. Obtain their IDs from AWS, then import
them before planning:

```bash
cd infra/terraform/cloudfront
terraform init
terraform import aws_cloudfront_distribution.web <existing-web-distribution-id>
terraform import aws_cloudfront_distribution.api <existing-api-distribution-id>
terraform plan
```

Import any existing custom cache policies into
`aws_cloudfront_cache_policy.web_origin_headers` and
`aws_cloudfront_cache_policy.graphql_public_reads`; otherwise Terraform will
create those policies and attach them during the first reviewed apply. AWS
credentials are not configured in this checkout, so the distribution IDs and
current policy IDs could not be discovered automatically.

Copy `terraform.tfvars.example`, set the existing aliases and ACM certificate
ARNs, then inspect the full plan. A CloudFront distribution import captures
state but does not reconstruct configuration; the first plan is the migration
diff and must be reviewed behavior-by-behavior before apply.

CloudFront behavior is intentionally conservative:

- `/_next/static/*` uses AWS's immutable optimized cache policy.
- `/en`, `/en/*`, `/hi`, and `/hi/*` honor the web origin's `Cache-Control`
  and vary by query string without accidentally matching paths such as `/engine`.
- Other web paths are not cached, preserving middleware redirects, service-worker
  updates, image optimization, and future authenticated routes.
- The API forwards every method. Only GET/HEAD can be cached; POST mutations and
  authenticated POST queries always reach Render.
- GraphQL cache keys include every query parameter, `Authorization`, and every
  cookie because those values are forwarded to the origin. The origin's
  `Cache-Control: no-store` still decides that unsuccessful/non-cacheable
  responses are not stored.

After DNS cutover, update Render's `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_SITE_URL` through the Render stack and rebuild the web service;
both values are compiled into the Next.js Docker image.
