mock_provider "cloudflare" {}

variables {
  zone_id                           = "11111111111111111111111111111111"
  adopt_cache_ruleset               = true
  cache_ruleset_inventory_confirmed = true
  additional_cache_rules = [{
    ref         = "existing-overbroad-api-rule"
    description = "A pre-existing broad rule whose unsafe cases must be overridden"
    expression  = "(http.host eq \"api.laxair.shop\")"
    action      = "set_cache_settings"
    enabled     = true
    action_parameters = {
      cache = true
    }
  }]
}

run "public_cache_is_narrow_and_origins_are_proxied" {
  command = plan

  assert {
    condition     = cloudflare_dns_record.web.proxied && cloudflare_dns_record.www.proxied && cloudflare_dns_record.api.proxied
    error_message = "Every Render-facing DNS record must pass through Cloudflare."
  }

  assert {
    condition     = length(cloudflare_ruleset.cache_settings[0].rules) == 3 && cloudflare_ruleset.cache_settings[0].rules[0].ref == "existing-overbroad-api-rule"
    error_message = "Additional inventoried cache rules must remain in the planned authoritative ruleset."
  }

  assert {
    condition = cloudflare_ruleset.cache_settings[0].rules[1].expression == (
      "(http.host eq \"api.laxair.shop\" and http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\"))"
    )
    error_message = "The cache rule must exactly target anonymous, cookieless GET /graphql requests on the API hostname."
  }

  assert {
    condition = cloudflare_ruleset.cache_settings[0].rules[2].expression == (
      "(http.host eq \"api.laxair.shop\" and not (http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\")))"
    )
    error_message = "Every API request except canonical anonymous GraphQL GET must match the final explicit bypass rule."
  }

  assert {
    condition     = cloudflare_ruleset.cache_settings[0].rules[2].enabled && !cloudflare_ruleset.cache_settings[0].rules[2].action_parameters.cache
    error_message = "The final unsafe GraphQL rule must be enabled and explicitly disable caching."
  }

  assert {
    condition     = cloudflare_ruleset.cache_settings[0].rules[1].action_parameters.edge_ttl.mode == "respect_origin"
    error_message = "Cloudflare must use the API's Cache-Control and bypass responses that are not cacheable."
  }

  assert {
    condition     = cloudflare_ruleset.cache_settings[0].rules[1].enabled && cloudflare_ruleset.cache_settings[0].rules[1].action_parameters.cache
    error_message = "The managed anonymous GraphQL cache rule must be enabled and cache-eligible."
  }

  assert {
    condition     = cloudflare_ruleset.cache_settings[0].rules[1].action_parameters.browser_ttl.mode == "respect_origin"
    error_message = "Cloudflare must not override the browser TTL supplied by the origin."
  }
}

run "rejects_unconfirmed_ruleset_adoption" {
  command = plan

  variables {
    adopt_cache_ruleset               = true
    cache_ruleset_inventory_confirmed = false
  }

  expect_failures = [cloudflare_ruleset.cache_settings[0]]
}
