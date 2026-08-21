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
  description = "Browser-facing web URL, normally the web CloudFront alias."
  type        = string
  default     = "https://laxair.shop"
}

variable "api_public_url" {
  description = "Browser-facing GraphQL URL, normally the API CloudFront alias."
  type        = string
  default     = "https://api.laxair.shop/graphql"
}

variable "blob_public_url" {
  description = "Public base URL for product media."
  type        = string
  default     = "https://images.laxair.shop"
}

variable "manage_custom_domains" {
  description = "Attach the public domains to Render. Keep false when those names point at CloudFront instead."
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
