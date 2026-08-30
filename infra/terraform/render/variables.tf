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

    OFF by default because turning it on CREATES a billable service. The API
    treats the cache as optional -- an unset REDIS_URL yields a null cache and
    every read falls through to Postgres -- so nothing breaks while this is
    false. Enable it, apply, then set REDIS_URL on the API service from the
    instance's connection info.
  EOT
  type        = bool
  default     = false
}

variable "key_value_plan" {
  description = <<-EOT
    Plan for the Key Value instance. The provider accepts `free`, `starter`,
    `standard`, `pro`, `pro_plus`.

    Defaults to `free`, matching every other service in this project. Be aware
    of one thing the provider schema cannot express: whether a given plan
    accepts `persistence_mode`. Render's free tiers have rejected settings the
    schema happily validates before -- `parameter_overrides` on free Postgres
    is the same shape -- so if an apply is refused for persistence, that is
    the plan talking, not the configuration. Move to `starter` or set
    `key_value_persistence_mode = "off"`.
  EOT
  type        = string
  default     = "free"
}

variable "key_value_persistence_mode" {
  description = <<-EOT
    Redis durability. `journal_snapshot` is the durable option -- a journal
    (Redis's AOF) alongside periodic snapshots -- and matches the dev stack's
    `--appendonly yes`.

    Separated from the resource so it can be dropped to `off` without editing
    main.tf if the chosen plan refuses it.
  EOT
  type        = string
  default     = "journal_snapshot"

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
