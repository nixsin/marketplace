locals {
  web_hostname                = var.zone_name
  www_hostname                = "www.${var.zone_name}"
  api_hostname                = "api.${var.zone_name}"
  graphql_cache_expression    = "(http.host eq \"api.${var.zone_name}\" and http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\"))"
  api_cache_bypass_expression = "(http.host eq \"api.${var.zone_name}\" and not (http.request.uri.path eq \"/graphql\" and http.request.method eq \"GET\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.headers[\"cookie\"][*] ne \"\")))"

  # WEB HTML. Deliberately a different cookie test from the API rules above.
  #
  # The API expressions bypass on ANY cookie, which is correct there: every
  # GraphQL read is anonymous and sent with credentials "omit", so a cookie
  # arriving at all means something unexpected. HTML cannot use that test --
  # next-intl's middleware sets NEXT_LOCALE on every page response, so every
  # returning visitor carries a cookie and nothing would ever cache.
  #
  # NEXT_LOCALE is safe to cache because it is derived purely from the URL
  # (/en sets en, /hi sets hi) and Cloudflare's cache key includes the URL,
  # so a cached response always carries the locale its own path implies.
  # mi_sid is the browser session id and is the one that must never be
  # shared, so it -- not cookies in general -- is what disables caching.
  #
  # Read through http.request.cookies, the parsed cookie map, NEVER through
  # http.request.headers["cookie"]. Two distinct bugs, and only one of them
  # is safe:
  #
  #   headers["cookie"][0] inspects only the FIRST Cookie header line, and
  #   HTTP/2 explicitly permits splitting Cookie across several lines. A
  #   session landing in a later line reads as anonymous, so the eligibility
  #   rule matches AND the bypass misses -- authenticated HTML in a shared
  #   cache. This is the unsafe direction.
  #
  #   `contains "mi_sid"` is a substring test over the raw header, so a
  #   cookie merely NAMED xmi_sid, or any cookie whose VALUE contained that
  #   string, would match. That direction only over-bypasses, costing hit
  #   rate rather than leaking, but it is still wrong.
  #
  # The cookie map fixes both: it parses every Cookie line and keys on the
  # exact cookie name.
  #
  # /_next/ is excluded because Cloudflare's default extension-based caching
  # already serves those as HIT; a rule here would only compete with it.
  # /sw.js is excluded belt-and-braces: it already ships no-store, and a
  # stale service-worker script caused a live outage on 2026-08-21 by
  # pinning a CSP that named a retired API host.
  #
  # THE BARE ROOT IS EXCLUDED, and this one is not belt-and-braces. GET /
  # is a 307 whose Location is negotiated from the NEXT_LOCALE cookie and
  # Accept-Language -- measured directly: en-US yields /en, hi-IN yields
  # /hi, and the cookie overrides both. NEITHER input is in the cache key,
  # and the response carries no Vary to say so.
  #
  # It also carries set-cookie: NEXT_LOCALE. So a cached root would not
  # merely redirect the wrong way, it would PIN the wrong locale into
  # other visitors' browsers persistently -- a worse failure than the
  # wrong redirect itself.
  #
  # Today the response carries no Cache-Control at all, so respect_origin
  # bypasses it anyway. That is not a reason to leave it matched: making
  # correctness depend on the ABSENCE of a header is the same trap this
  # repo already hit with GraphQL errors, where success turned out to be a
  # property of the body rather than the status line. Excluding it costs
  # nothing -- / is a redirect, not a rendered page, so there is no
  # latency to win -- while /en and /hi, the pages people actually land
  # on, still cache.
  #
  # AUTHORIZATION is rejected on the same footing as mi_sid, matching what
  # the API eligibility rule already does. Browsers do not send it on a
  # normal page load, so this is defence in depth rather than a live bug --
  # but put the site behind HTTP Basic auth for staging protection and
  # every request suddenly carries it, which would otherwise place
  # protected HTML in a shared cache.
  web_html_cache_expression = "(http.host eq \"${var.zone_name}\" and http.request.method eq \"GET\" and not starts_with(http.request.uri.path, \"/_next/\") and http.request.uri.path ne \"/sw.js\" and http.request.uri.path ne \"/\" and not any(http.request.headers[\"authorization\"][*] ne \"\") and not any(http.request.cookies[\"mi_sid\"][*] ne \"\"))"

  # The complement: within the SAME path scope as the rule above, anything
  # that is not an anonymous GET is never cacheable. Stated explicitly
  # rather than left implicit, so a broader rule elsewhere in the phase
  # cannot leave authenticated HTML eligible. This is the guard that makes
  # login safe to add later without revisiting the CDN.
  #
  # The /_next/ and /sw.js exclusions must be repeated here, and leaving
  # them off was a real bug: a logged-in browser sends mi_sid on EVERY
  # same-origin request, including static chunks, so a host-wide bypass
  # stripped edge caching from content-hashed immutable assets that are
  # byte-identical for every user -- contradicting the reason the rule
  # above excludes them. Zero impact today because no login ships yet, but
  # this rule exists precisely so that login can ship without revisiting
  # the CDN, so it has to be right before then rather than after.
  #
  # With both exclusions present the pair is an exact complement over
  # (host and not /_next/ and not /sw.js): eligible = GET and no session;
  # bypass = not (GET and no session). /_next/ and /sw.js match NEITHER
  # rule and fall through to Cloudflare's defaults, which is what the
  # comment above always claimed.
  web_html_bypass_expression = "(http.host eq \"${var.zone_name}\" and not starts_with(http.request.uri.path, \"/_next/\") and http.request.uri.path ne \"/sw.js\" and http.request.uri.path ne \"/\" and (http.request.method ne \"GET\" or any(http.request.headers[\"authorization\"][*] ne \"\") or any(http.request.cookies[\"mi_sid\"][*] ne \"\")))"
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

  zone_id = var.zone_id
  # Cloudflare creates this zone-level phase entry with the immutable name
  # "default". Keep its live identity so adoption is always in-place.
  name        = "default"
  description = ""
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
    ref         = "cache-public-html"
    description = "Cache anonymous page HTML using origin Cache-Control"
    expression  = local.web_html_cache_expression
    action      = "set_cache_settings"
    enabled     = true

    action_parameters = {
      cache = true
      edge_ttl = {
        # The origin already sends s-maxage=60, stale-while-revalidate=300.
        # Respecting it keeps the TTL in one place -- the application --
        # rather than splitting it between code and dashboard.
        mode = "respect_origin"
      }
      browser_ttl = {
        # respect_origin, never a fixed value. The zone-level Browser Cache
        # TTL default of 4 hours once overrode the origin's max-age=0 and
        # left browsers holding stale API responses; the same mistake on
        # HTML would pin a whole page.
        mode = "respect_origin"
      }
      serve_stale = {
        disable_stale_while_updating = false
      }
      respect_strong_etags = true
    }
    }, {
    ref         = "bypass-authenticated-web"
    description = "Never cache page HTML for a request carrying a session"
    expression  = local.web_html_bypass_expression
    action      = "set_cache_settings"
    enabled     = true

    action_parameters = {
      cache = false
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
