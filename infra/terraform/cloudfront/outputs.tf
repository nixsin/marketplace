output "web_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "web_distribution_domain" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "api_distribution_id" {
  value = aws_cloudfront_distribution.api.id
}

output "api_distribution_domain" {
  value = aws_cloudfront_distribution.api.domain_name
}

output "dns_records" {
  description = "Create proxied-off CNAME/ALIAS records at the authoritative DNS provider after certificate validation."
  value = {
    web = { for alias in var.web_aliases : alias => aws_cloudfront_distribution.web.domain_name }
    api = { for alias in var.api_aliases : alias => aws_cloudfront_distribution.api.domain_name }
  }
}
