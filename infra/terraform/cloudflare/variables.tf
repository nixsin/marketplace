variable "account_id" {
  description = "Cloudflare account identifier (not a secret)."
  type        = string
  default     = "e922aa08db001f9e90a323fc6765e529"
}

variable "zone_id" {
  description = "Cloudflare zone identifier for laxair.shop. Discover with scripts/cloudflare-terraform-ids.sh."
  type        = string
}

variable "zone_name" {
  description = "Authoritative Cloudflare zone."
  type        = string
  default     = "laxair.shop"
}

variable "web_origin" {
  description = "Render web origin hostname."
  type        = string
  default     = "medinstru-web.onrender.com"
}

variable "api_origin" {
  description = "Render API origin hostname."
  type        = string
  default     = "medinstru-api.onrender.com"
}

variable "r2_bucket_name" {
  description = "Existing R2 media bucket."
  type        = string
  default     = "medinstru-media"
}

variable "adopt_cache_ruleset" {
  description = "Manage the zone cache-settings phase only after its complete live rule inventory is represented."
  type        = bool
  default     = false
}

variable "cache_ruleset_inventory_confirmed" {
  description = "Explicit acknowledgement that every live cache-settings rule is represented before adoption."
  type        = bool
  default     = false
}

variable "additional_cache_rules" {
  description = "Complete additional live cache-settings rules, copied from the existing ruleset before adoption."
  type        = any
  default     = []
}

variable "locales" {
  description = "Locale prefixes the web app serves. MUST match LOCALES in packages/config/src/index.js -- scripts/cloudflare-locale-drift.test.mjs fails the build if they diverge."
  type        = list(string)
  default     = ["en", "hi"]
}
