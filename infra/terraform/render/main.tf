locals {
  api_service_id   = "srv-da02lnojo6nc73djh9bg"
  api_service_name = "medinstru-api"
  web_service_id   = "srv-da02mt61egvs73fopb00"
  web_service_name = "medinstru-web"

  common_docker = {
    repo_url            = var.repository_url
    branch              = var.branch
    auto_deploy_trigger = "checksPass"
    context             = "."
  }
}

# These reads are deliberate creation guards. If either legacy free service is
# deleted outside Terraform, planning must fail here instead of recreating it
# from a configuration the provider cannot safely update on the free tier.
data "render_web_service" "existing_api" {
  id = local.api_service_id
}

data "render_web_service" "existing_web" {
  id = local.web_service_id
}

# Keep these imports declarative and permanent. If the HCP state is ever empty
# or restored without these addresses, Terraform adopts the known production
# objects instead of planning duplicate services or a duplicate database.
import {
  to = render_postgres.main
  id = "dpg-da02hq7lk1mc73f01hkg-a"
}

import {
  to = render_web_service.api
  id = local.api_service_id
}

import {
  to = render_web_service.web
  id = local.web_service_id
}

resource "render_postgres" "main" {
  name           = "medinstru-postgres"
  plan           = var.postgres_plan
  region         = var.region
  version        = "18"
  environment_id = var.environment_id

  # GitHub Actions runs production migrations through Render's external
  # database endpoint. Omitting this optional-computed field caused provider
  # v1.9.1 to clear the imported allow-all rule during the first apply.
  ip_allow_list = [{
    cidr_block  = "0.0.0.0/0"
    description = "everywhere"
  }]

  lifecycle {
    prevent_destroy = true

    # THE SAME BUG AS ip_allow_list ABOVE, for every remaining field of its
    # kind. Provider v1.9.1 sends null for an optional+computed attribute
    # the configuration omits, which is how the first apply silently wiped
    # the imported allow-list and broke production migrations with P1017.
    #
    # `terraform providers schema -json` lists exactly six such attributes
    # on render_postgres. ip_allow_list is declared above because we want
    # Terraform to assert it. These five are NOT declared, so without this
    # they are the next ones to be cleared:
    #
    #   database_name / database_user  the API's DATABASE_URL embeds both;
    #                                  losing them breaks every query
    #   disk_size_gb                   free tier has fixed storage
    #   high_availability_enabled      unavailable on free
    #   log_stream_override            dashboard-managed
    #
    # ignore_changes rather than explicit values on purpose: the live
    # database name and user are only readable from the connection secret,
    # and declaring a WRONG value is worse than declaring none -- it plans
    # a replacement of the production database. Ignoring makes Terraform
    # plan from prior state instead of null, preserving whatever Render
    # actually has.
    #
    # If any of these ever needs to be managed, read the live value first,
    # declare it explicitly, and remove it from this list -- one at a time.
    ignore_changes = [
      database_name,
      database_user,
      disk_size_gb,
      high_availability_enabled,
      log_stream_override,
    ]
  }
}

resource "render_web_service" "api" {
  name              = local.api_service_name
  plan              = var.web_service_plan
  region            = var.region
  health_check_path = "/"

  runtime_source = {
    docker = merge(local.common_docker, {
      dockerfile_path = "./apps/api/Dockerfile"
    })
  }

  env_vars = {
    PORT = { value = "4000" }
    DATABASE_URL = {
      value = render_postgres.main.connection_info.internal_connection_string
    }
    JWT_SECRET                = { value = var.jwt_secret }
    NEXT_PUBLIC_BLOB_BASE_URL = { value = var.blob_public_url }
  }

  custom_domains = var.manage_custom_domains ? [
    for domain in var.api_custom_domains : { name = domain }
  ] : []

  lifecycle {
    # Render's API rejects every update to legacy free services when the
    # official provider echoes their computed maintenance_mode. Keep the
    # imported object/state update-frozen, but manage live settings manually until
    # the service is upgraded or the provider stops sending that field.
    ignore_changes  = all
    prevent_destroy = true

    precondition {
      condition = (
        data.render_web_service.existing_api.id == local.api_service_id &&
        data.render_web_service.existing_api.name == local.api_service_name
      )
      error_message = "The existing free API service is missing; recover it manually and import it instead of allowing Terraform to recreate it."
    }
  }
}

resource "render_web_service" "web" {
  name   = local.web_service_name
  plan   = var.web_service_plan
  region = var.region

  runtime_source = {
    docker = merge(local.common_docker, {
      dockerfile_path = "./apps/web/Dockerfile"
    })
  }

  env_vars = {
    NEXT_PUBLIC_API_URL       = { value = var.api_public_url }
    NEXT_PUBLIC_SITE_URL      = { value = var.web_public_url }
    NEXT_PUBLIC_BLOB_BASE_URL = { value = var.blob_public_url }
  }

  custom_domains = var.manage_custom_domains ? [
    for domain in var.web_custom_domains : { name = domain }
  ] : []

  lifecycle {
    # See the API service lifecycle note above. Both legacy free services are
    # intentionally import-only so routine applies cannot fail mid-run or
    # accidentally change production while the provider is incompatible.
    ignore_changes  = all
    prevent_destroy = true

    precondition {
      condition = (
        data.render_web_service.existing_web.id == local.web_service_id &&
        data.render_web_service.existing_web.name == local.web_service_name
      )
      error_message = "The existing free web service is missing; recover it manually and import it instead of allowing Terraform to recreate it."
    }
  }
}
