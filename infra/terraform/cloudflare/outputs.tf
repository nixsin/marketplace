output "zone_id" {
  value = var.zone_id
}

output "web_hostname" {
  value = cloudflare_dns_record.web.name
}

output "api_hostname" {
  value = cloudflare_dns_record.api.name
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.media.name
}
