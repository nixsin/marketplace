variable "owner_id" {
  description = "Render team that owns the production resources."
  type        = string
  default     = "tea-da02feht0dsc738nmfv0"
}

variable "environment_id" {
  description = "Existing Render project environment containing the production database."
  type        = string
  default     = "evm-da02hptg1s2s73c6e7tg"
}

variable "repository_url" {
  description = "Git repository Render builds from."
  type        = string
  default     = "https://github.com/nixsin/marketplace"
}

variable "branch" {
  description = "Production branch."
  type        = string
  default     = "main"
}

variable "region" {
  description = "Render region shared by the services and database."
  type        = string
  default     = "singapore"
}

variable "web_service_plan" {
  description = "Schema-valid placeholder for imported legacy-free services. Plan changes are ignored to prevent an accidental paid upgrade."
  type        = string
  default     = "starter"
}

variable "postgres_plan" {
  description = "Render Postgres plan. The existing database can be imported while it remains on free."
  type        = string
  default     = "free"
}

variable "web_public_url" {
  description = "Browser-facing web URL, normally the Cloudflare-proxied domain."
  type        = string
  default     = "https://laxair.shop"
}

variable "api_public_url" {
  description = "Browser-facing GraphQL URL, normally the Cloudflare-proxied API domain."
  type        = string
  default     = "https://api.laxair.shop/graphql"
}

variable "blob_public_url" {
  description = "Public base URL for product media."
  type        = string
  default     = "https://images.laxair.shop"
}

variable "manage_custom_domains" {
  description = "Attach the public domains to Render so Cloudflare can proxy to certificate-valid origins."
  type        = bool
  default     = true
}

variable "jwt_secret" {
  description = "Existing production JWT secret. Supply through TF_VAR_jwt_secret; never commit it."
  type        = string
  sensitive   = true
}

variable "web_custom_domains" {
  description = "Domains attached directly to the Render web service when manage_custom_domains is true."
  type        = set(string)
  default     = ["laxair.shop", "www.laxair.shop"]
}

variable "api_custom_domains" {
  description = "Domains attached directly to the Render API service when manage_custom_domains is true."
  type        = set(string)
  default     = ["api.laxair.shop"]
}

variable "enable_key_value" {
  description = <<-EOT
    Create the Redis (Render Key Value) instance the API's shared cache uses.

    ON, and free. Render's Key Value has a free plan -- 25 MB, one instance
    per workspace -- so this costs nothing at the plan defaults below. It was
    off originally on the assumption that any Key Value instance is billable;
    that turned out to be wrong, and the only thing the free plan actually
    withholds is persistence (see `key_value_persistence_mode`).

    Still a real switch rather than a hardcoded resource, because the API
    treats the cache as OPTIONAL by construction: an unset REDIS_URL yields a
    null cache and every read falls through to Postgres. Setting this to
    false is a supported state, not a broken one.

    Turning it on is the whole operation -- there is no dashboard step.
    Terraform creates the instance, reads its internal connection string into
    an env group, and links that group to the API service, so the credential
    is never typed, pasted, or held by a person.
  EOT
  type        = bool
  default     = true
}

variable "key_value_plan" {
  description = <<-EOT
    Plan for the Key Value instance. The provider accepts `free`, `starter`,
    `standard`, `pro`, `pro_plus`.

    `free` is deliberate and sufficient, not a placeholder. It gives 25 MB and
    allows one active instance per workspace; the cache holds a single small
    counter key today, so neither limit is anywhere near binding. The one
    thing free withholds is persistence, which `key_value_persistence_mode`
    handles.

    Note the free plan here is NOT the free-Postgres situation. Free Postgres
    expires 30 days after creation; free Key Value carries no such clock, so
    this instance is not on a deletion timer.
  EOT
  type        = string
  default     = "free"
}

variable "key_value_persistence_mode" {
  description = <<-EOT
    Redis durability. `journal_snapshot` is the durable option -- a journal
    (Redis's AOF) alongside periodic snapshots -- and matches the dev stack's
    `--appendonly yes`.

    `off` by default, because the free plan does not offer the alternative:
    Render's docs are explicit that "data persistence is not available for
    free Key Value instances", and that a free instance loses all of its data
    whenever it restarts. Sending `journal_snapshot` on `free` is the
    documented shape of a refused apply -- the plan talking, not the
    configuration.

    THAT IS SAFE HERE, and for a structural reason rather than a tolerance for
    risk: the catalogue version lives in Postgres (`CacheVersion`), not in
    Redis. Redis only ever holds values ADDRESSED BY that version, so a wiped
    instance cannot serve a stale answer -- it can only miss, and a miss is
    the null-cache path the API already runs on. Losing the cache costs
    latency, never correctness.

    What `off` gives up is the warm-cache-after-restart property, which is why
    a durable mode was wanted originally: a cold cache makes an outage worse
    at exactly the wrong moment. On a few dozen products that is one COUNT(*)
    against a tiny table. Raise this to `journal_snapshot` at the same time as
    moving off `free`, not before -- the two settings are coupled by the plan.
  EOT
  type        = string
  default     = "off"

  validation {
    condition     = contains(["journal_snapshot", "snapshot", "off"], var.key_value_persistence_mode)
    error_message = "Must be journal_snapshot, snapshot, or off — Render does not use Redis's own 'aof' vocabulary."
  }
}

variable "postgres_parameter_overrides" {
  description = <<-EOT
    Postgres server parameters, applied through the provider's
    `parameter_overrides` map.

    EMPTY by default, and that is not laziness. Render's free tier does not
    accept parameter overrides, and this repo's database is on free until it
    is migrated -- sending them would fail the apply for no benefit. The WAL
    settings worth setting on a paid plan are documented in main.tf next to
    the resource; move them here when the plan changes.
  EOT
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------
# The environment contract's variables, delivered to both services
# ---------------------------------------------------------------------

variable "inquiry_ip_hash_secret" {
  description = <<-EOT
    Keys the HMAC that stores an inquiry submitter's IP as a hash.

    EMPTY BY DEFAULT, and empty is a real, documented state rather than a
    gap: the per-IP rate limit simply does not run. That is the honest
    option, because an unkeyed digest over IPv4's 2^32 space is reversible
    by anyone holding the table -- storing nothing beats storing something
    that only looks protected.

    Supply a real value through TF_VAR_inquiry_ip_hash_secret when you want
    the limit on; never commit one. Generate with `openssl rand -hex 24`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "sourcemap_signing_key" {
  description = <<-EOT
    Signs source-map access tokens for apps/web.

    EMPTY BY DEFAULT: the /sourcemaps route fails closed, so maps are
    unavailable rather than public. That is the safe state, not a broken
    one -- see CLAUDE.md's source-map section.

    Supply through TF_VAR_sourcemap_signing_key; never commit one. Generate
    with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "blob_provider" {
  description = <<-EOT
    Object-storage provider for uploads: r2, s3, b2, spaces, minio, or local.

    `local` is the default and IS permitted on a deployment -- the refusal
    lives at the write instead. Nothing in the app injects BLOB_STORE yet, so
    blocking a deploy here would be an error over a capability with no call
    sites; `LocalBlobStore.put()` throws on a deployment instead, naming this
    variable, at the moment an upload is first attempted. See CLAUDE.md.
  EOT
  type        = string
  default     = "local"

  validation {
    condition     = contains(["r2", "s3", "b2", "spaces", "minio", "local"], var.blob_provider)
    error_message = "Must be one of r2, s3, b2, spaces, minio, local — the providers apps/api has an adapter for."
  }
}

variable "blob_access_key_id" {
  description = "Object-storage access key id. Empty is correct while blob_provider is `local`. Supply through TF_VAR_blob_access_key_id."
  type        = string
  sensitive   = true
  default     = ""
}

variable "blob_secret_access_key" {
  description = "Object-storage secret. Empty is correct while blob_provider is `local`. Supply through TF_VAR_blob_secret_access_key."
  type        = string
  sensitive   = true
  default     = ""
}

variable "whatsapp_access_token" {
  description = "Meta Cloud API token. EMPTY means WhatsApp delivery is off: inquiries are still recorded, just not sent. Supply through TF_VAR_whatsapp_access_token."
  type        = string
  sensitive   = true
  default     = ""
}

variable "whatsapp_phone_number_id" {
  description = "Meta's NUMERIC sender id -- not a phone number. Empty means delivery is off."
  type        = string
  default     = ""
}

variable "whatsapp_template_name" {
  description = "The approved template name (lowercase, digits, underscores). Empty means delivery is off."
  type        = string
  default     = ""
}

variable "whatsapp_template_language" {
  description = "The template's approved locale, e.g. `en` or `en_US`. Empty falls back to the service's documented default."
  type        = string
  default     = ""
}

variable "inquiry_trust_proxy_headers" {
  description = <<-EOT
    Whether to derive a submitter's address from cf-connecting-ip.

    "false" by default and deliberately so: this origin also answers directly
    on its .onrender.com hostname, so a caller who skips the edge can set the
    header themselves. Setting "true" asserts the origin now REFUSES traffic
    that did not arrive through Cloudflare -- not merely that a proxy exists.
  EOT
  type        = string
  default     = "false"

  validation {
    condition     = contains(["true", "false"], var.inquiry_trust_proxy_headers)
    error_message = "Must be exactly \"true\" or \"false\" — the app compares the string."
  }
}
