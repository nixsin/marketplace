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

# Rules are looked up by ref, never by index. The first version of this file
# asserted on rules[1] and rules[2], so inserting any rule ahead of them
# silently repointed every later assertion at a different rule -- the tests
# would still pass, just no longer testing what they name. one() returns null
# for a ref that does not exist, so a renamed rule fails loudly instead.

run "public_cache_is_narrow_and_origins_are_proxied" {
  command = plan

  assert {
    condition     = cloudflare_dns_record.web.proxied && cloudflare_dns_record.www.proxied && cloudflare_dns_record.api.proxied
    error_message = "Every Render-facing DNS record must pass through Cloudflare."
  }

  assert {
    condition     = length(cloudflare_ruleset.cache_settings[0].rules) == 5 && cloudflare_ruleset.cache_settings[0].rules[0].ref == "existing-overbroad-api-rule"
    error_message = "Additional inventoried cache rules must remain, first, in the planned authoritative ruleset."
  }

  assert {
    condition = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-graphql-gets"]).expression == (
      "(http.host eq \"api.laxair.shop\" and http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\"))"
    )
    error_message = "The cache rule must exactly target anonymous, cookieless GET /graphql requests on the API hostname."
  }

  assert {
    condition = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "bypass-all-other-api-requests"]).expression == (
      "(http.host eq \"api.laxair.shop\" and not (http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\")))"
    )
    error_message = "Every API request except canonical anonymous GraphQL GET must match the final explicit bypass rule."
  }

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "bypass-all-other-api-requests"]).enabled && !one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "bypass-all-other-api-requests"]).action_parameters.cache
    error_message = "The final unsafe GraphQL rule must be enabled and explicitly disable caching."
  }

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-graphql-gets"]).action_parameters.edge_ttl.mode == "respect_origin"
    error_message = "Cloudflare must use the API's Cache-Control and bypass responses that are not cacheable."
  }

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-graphql-gets"]).enabled && one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-graphql-gets"]).action_parameters.cache
    error_message = "The managed anonymous GraphQL cache rule must be enabled and cache-eligible."
  }

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-graphql-gets"]).action_parameters.browser_ttl.mode == "respect_origin"
    error_message = "Cloudflare must not override the browser TTL supplied by the origin."
  }
}

run "page_html_is_cacheable_only_while_anonymous" {
  command = plan

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).enabled && one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).action_parameters.cache
    error_message = "Page HTML must be cache-eligible; leaving it DYNAMIC was the last remaining CDN gap."
  }

  assert {
    condition = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).expression == (
      "(http.host eq \"laxair.shop\" and http.request.method eq \"GET\" and not starts_with(http.request.uri.path, \"/_next/\") and http.request.uri.path ne \"/sw.js\" and not http.request.headers[\"cookie\"][0] contains \"mi_sid\")"
    )
    error_message = "The HTML rule must match anonymous GETs on the web host only, excluding /_next/ and /sw.js."
  }

  assert {
    # Deliberately NOT the API rules' "no cookie at all" test. next-intl sets
    # NEXT_LOCALE on every page response, so a cookieless test would mean HTML
    # never caches for any returning visitor. NEXT_LOCALE is safe because it is
    # derived from the URL, which is already in the cache key.
    condition     = !strcontains(one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).expression, "any(http.request.headers[\"cookie\"][*] ne \"\")")
    error_message = "HTML must not use the API's cookieless test -- NEXT_LOCALE would stop it ever caching."
  }

  assert {
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "bypass-authenticated-web"]).enabled && !one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "bypass-authenticated-web"]).action_parameters.cache
    error_message = "A session-bearing request must never be served page HTML from a shared cache."
  }

  assert {
    # Order is load-bearing: Cloudflare runs every matching rule in sequence
    # and the last one wins, so a bypass placed BEFORE its eligibility rule is
    # silently overridden by it. This is the assertion that would catch that.
    condition     = index([for r in cloudflare_ruleset.cache_settings[0].rules : r.ref], "cache-public-html") < index([for r in cloudflare_ruleset.cache_settings[0].rules : r.ref], "bypass-authenticated-web")
    error_message = "The authenticated bypass must come after the HTML cache rule or it is overridden."
  }

  assert {
    # The zone-level Browser Cache TTL default of 4 hours once overrode the
    # origin's max-age=0 and left browsers holding stale API responses. The
    # same mistake on HTML would pin a whole page for four hours.
    condition     = one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).action_parameters.edge_ttl.mode == "respect_origin" && one([for r in cloudflare_ruleset.cache_settings[0].rules : r if r.ref == "cache-public-html"]).action_parameters.browser_ttl.mode == "respect_origin"
    error_message = "HTML TTLs must come from the origin's Cache-Control, never a fixed Cloudflare value."
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
