locals {
  web_hostname                = var.zone_name
  www_hostname                = "www.${var.zone_name}"
  api_hostname                = "api.${var.zone_name}"
  graphql_cache_expression    = "(http.host eq \"api.${var.zone_name}\" and http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\"))"
  api_cache_bypass_expression = "(http.host eq \"api.${var.zone_name}\" and not (http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\")))"
}

resource "cloudflare_dns_record" "web" {
  zone_id = var.zone_id
  name    = local.web_hostname
  type    = "CNAME"
  content = var.web_origin
  ttl     = 1
  proxied = true
  comment = "Render web origin, proxied through Cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.zone_id
  name    = local.www_hostname
  type    = "CNAME"
  content = var.web_origin
  ttl     = 1
  proxied = true
  comment = "Render www origin, proxied through Cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = local.api_hostname
  type    = "CNAME"
  content = var.api_origin
  ttl     = 1
  proxied = true
  comment = "Render API origin, proxied through Cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "media" {
  account_id    = var.account_id
  name          = var.r2_bucket_name
  location      = "apac"
  jurisdiction  = "default"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# A root ruleset owns the entire zone's cache-settings phase. Import the
# existing phase ruleset before apply; never create a second authoritative
# ruleset or omit unrelated rules that already exist in the dashboard.
resource "cloudflare_ruleset" "cache_settings" {
  count = var.adopt_cache_ruleset ? 1 : 0

  zone_id     = var.zone_id
  name        = "medinstru cache policy"
  description = "Cache safe public reads using origin freshness headers"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  # Preserve the live inventory's order, then apply both sides of the policy:
  # eligible anonymous GETs and an explicit final bypass for everything unsafe.
  # The bypass is essential: an unsafe request does not match the eligibility
  # rule, so without it an earlier broad dashboard rule could remain in force.
  rules = concat(var.additional_cache_rules, [{
    ref         = "cache-public-graphql-gets"
    description = "Cache anonymous GraphQL GET reads using origin Cache-Control"
    expression  = local.graphql_cache_expression
    action      = "set_cache_settings"
    enabled     = true

    action_parameters = {
      cache = true
      edge_ttl = {
        mode = "respect_origin"
      }
      browser_ttl = {
        mode = "respect_origin"
      }
      serve_stale = {
        disable_stale_while_updating = false
      }
      respect_strong_etags = true
    }
    }, {
    ref         = "bypass-all-other-api-requests"
    description = "Never cache anything except canonical anonymous GraphQL GET reads"
    expression  = local.api_cache_bypass_expression
    action      = "set_cache_settings"
    enabled     = true

    action_parameters = {
      cache = false
    }
  }])

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.cache_ruleset_inventory_confirmed
      error_message = "Inventory every live cache-settings rule and set cache_ruleset_inventory_confirmed=true before adoption."
    }
  }
}
