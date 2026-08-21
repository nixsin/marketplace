mock_provider "aws" {}

run "cache_is_partitioned_and_routes_are_scoped" {
  command = plan

  assert {
    condition     = aws_cloudfront_cache_policy.graphql_public_reads.parameters_in_cache_key_and_forwarded_to_origin[0].cookies_config[0].cookie_behavior == "all"
    error_message = "Every cookie forwarded to GraphQL must be part of its cache key."
  }

  assert {
    condition     = toset(aws_cloudfront_cache_policy.graphql_public_reads.parameters_in_cache_key_and_forwarded_to_origin[0].headers_config[0].headers[0].items) == toset(["Authorization"])
    error_message = "Authorization must partition the GraphQL cache."
  }

  assert {
    condition = toset([
      for behavior in aws_cloudfront_distribution.web.ordered_cache_behavior : behavior.path_pattern
      if startswith(behavior.path_pattern, "/en") || startswith(behavior.path_pattern, "/hi")
    ]) == toset(["/en", "/en/*", "/hi", "/hi/*"])
    error_message = "Locale caching must cover only exact locale roots and slash-scoped descendants."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].cached_methods == toset(["GET", "HEAD"])
    error_message = "CloudFront must never cache API mutation methods."
  }
}
