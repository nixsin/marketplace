locals {
  web_origin_id = "render-web"
  api_origin_id = "render-api"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_cache_policy" "web_origin_headers" {
  name        = "medinstru-web-origin-cache-control"
  comment     = "Use origin Cache-Control for locale HTML while varying by query string"
  default_ttl = 0
  min_ttl     = 0
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

resource "aws_cloudfront_cache_policy" "graphql_public_reads" {
  name        = "medinstru-graphql-origin-cache-control"
  comment     = "Cache GraphQL GETs by complete query and authorization identity"
  default_ttl = 0
  min_ttl     = 0
  max_ttl     = 300

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      # AllViewerExceptHostHeader forwards cookies to the API. They must
      # therefore participate in the cache key too: forwarding a value
      # that can affect a response without varying the cache on that value
      # is a cross-user cache leak waiting to happen.
      cookie_behavior = "all"
    }

    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Authorization"]
      }
    }

    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled          = true
  is_ipv6_enabled  = true
  comment          = "Medinstru web CDN backed by Render"
  aliases          = var.web_aliases
  price_class      = var.price_class
  http_version     = "http2and3"
  retain_on_delete = true

  origin {
    domain_name = var.web_origin_domain
    origin_id   = local.web_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = local.web_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.web_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  dynamic "ordered_cache_behavior" {
    # Exact roots plus slash-scoped descendants. `/en*` also matches
    # unrelated paths such as `/engine`, which must stay on the safe,
    # uncached default behavior.
    for_each = toset(["/en", "/en/*", "/hi", "/hi/*"])
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = local.web_origin_id
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = aws_cloudfront_cache_policy.web_origin_headers.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = length(var.web_aliases) == 0
    acm_certificate_arn            = length(var.web_aliases) == 0 ? null : var.web_certificate_arn
    ssl_support_method             = length(var.web_aliases) == 0 ? null : "sni-only"
    minimum_protocol_version       = length(var.web_aliases) == 0 ? "TLSv1" : "TLSv1.2_2021"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudfront_distribution" "api" {
  enabled          = true
  is_ipv6_enabled  = true
  comment          = "Medinstru GraphQL CDN backed by Render"
  aliases          = var.api_aliases
  price_class      = var.price_class
  http_version     = "http2and3"
  retain_on_delete = true

  origin {
    domain_name = var.api_origin_domain
    origin_id   = local.api_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = local.api_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.graphql_public_reads.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = length(var.api_aliases) == 0
    acm_certificate_arn            = length(var.api_aliases) == 0 ? null : var.api_certificate_arn
    ssl_support_method             = length(var.api_aliases) == 0 ? null : "sni-only"
    minimum_protocol_version       = length(var.api_aliases) == 0 ? "TLSv1" : "TLSv1.2_2021"
  }

  lifecycle {
    prevent_destroy = true
  }
}
