output "web_service_id" {
  value = render_web_service.web.id
}

output "web_origin_url" {
  value = render_web_service.web.url
}

output "api_service_id" {
  value = render_web_service.api.id
}

output "api_origin_url" {
  value = render_web_service.api.url
}

output "postgres_id" {
  value = render_postgres.main.id
}
