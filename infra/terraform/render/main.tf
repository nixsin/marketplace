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

  # Postgres server parameters, including the write-ahead log.
  #
  # EMPTY on the free plan, which does not accept overrides -- sending any
  # would fail the apply. Declared here so the knob is in code rather than in
  # someone's memory, and so moving to a paid plan is a variable change rather
  # than an archaeology exercise.
  #
  # What to set when the plan allows it, and why:
  #
  #   wal_level = "replica"          Enough WAL detail for physical replication
  #                                  and PITR. "minimal" is faster and cannot be
  #                                  recovered from, which is the wrong trade for
  #                                  a database with no backup strategy today
  #                                  (docs/render.md §6).
  #   max_wal_size = "2GB"           Fewer forced checkpoints under write bursts
  #                                  -- bulk upload is the coming one.
  #   checkpoint_timeout = "15min"   Spreads checkpoint I/O rather than spiking it.
  #   wal_compression = "on"         Smaller WAL for the same durability; costs CPU
  #                                  that this workload is not short of.
  #
  # Render manages backups and PITR at the plan level rather than through
  # parameters, so those are a plan decision, not a setting.
  parameter_overrides = var.postgres_parameter_overrides

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

# Redis for the API's shared cache. See apps/api/src/cache/README.md for what
# it holds and why invalidation is version-keyed rather than delete-based.
#
# ON, and free. Render's Key Value has a free plan -- 25 MB, one active
# instance per workspace -- so this costs nothing at the defaults. It was
# gated off originally on the belief that ANY Key Value instance is billable,
# which was simply wrong; the only thing free withholds is persistence, and
# see persistence_mode below for why that is safe here.
#
# `terraform apply` is the entire operation. Creation, credential delivery and
# service wiring are all declared below, so there is no dashboard step and
# nobody ever handles the connection string.
#
# Still a switch rather than an unconditional resource, because the API treats
# the cache as OPTIONAL by construction: an unset REDIS_URL yields a null
# cache and every read falls through to Postgres. enable_key_value = false is
# a supported state, not a broken one.
resource "render_keyvalue" "cache" {
  count = var.enable_key_value ? 1 : 0

  name           = "medinstru-cache"
  plan           = var.key_value_plan
  region         = var.region
  environment_id = var.environment_id

  # Redis's write-ahead log. Render calls the durable option
  # "journal_snapshot" -- a journal (Redis's AOF) alongside periodic
  # snapshots -- rather than using Redis's own vocabulary. `terraform
  # validate` is what surfaced that: "aof" is not an accepted value, and the
  # accepted set is ["journal_snapshot" "snapshot" "off"]. Worth validating
  # rather than assuming the provider mirrors the underlying engine's names.
  #
  # DEFAULTS TO "off", because the free plan offers nothing else: Render
  # documents that persistence is unavailable on free Key Value, and that a
  # free instance loses all of its data whenever it restarts. Sending
  # journal_snapshot on `free` is the documented shape of a refused apply.
  #
  # That INVERTS a claim this comment used to make -- that `--appendonly yes
  # --appendfsync everysec` on the dev stack in docker-compose.yml keeps local
  # behaviour from being quietly more forgiving than production. On free it is
  # now the other way round: dev persists, production does not. The dev stack
  # is deliberately left alone rather than crippled to match, because here the
  # asymmetry runs in the SAFE direction. A wiped cache cannot produce a wrong
  # answer at all -- the catalogue version lives in Postgres (CacheVersion)
  # and Redis only ever holds values ADDRESSED BY that version, so an empty
  # instance can only miss, and a miss is the null-cache path the API already
  # runs on. What differs between the two environments is how often a miss
  # happens, never what an answer says.
  #
  # What "off" gives up is the warm cache after a restart, which was the whole
  # reason to want a durable mode: a cold cache makes an outage worse at
  # exactly the wrong moment. On a few dozen products that is one COUNT(*)
  # against a tiny table. Raise this back to journal_snapshot together with
  # key_value_plan, never on its own -- free refuses it and the apply fails.
  persistence_mode = var.key_value_persistence_mode

  # Evict the least-recently-used key rather than returning errors when full.
  # A cache that refuses writes is worse than one that forgets: the former
  # surfaces as failures, the latter as a miss the caller already handles.
  max_memory_policy = "allkeys_lru"

  lifecycle {
    prevent_destroy = true
  }
}

# REDIS_URL, delivered to the API without anyone handling the credential.
#
# This is the whole point of doing it in Terraform rather than the dashboard:
# the connection string is read straight off the Key Value resource above and
# written into an env group. It is never typed, never pasted, never in a shell
# history, and never in this repository -- Render generates it, Terraform
# moves it, and the API receives it.
#
# The INTERNAL connection string, not the external one. Both services live in
# the same Render environment, so internal keeps the traffic off the public
# network and out of egress accounting. The external string exists for
# connecting from a laptop, which is not what the API is doing.
#
# An env group rather than setting env_vars on the service directly, because
# render_web_service.api carries `ignore_changes = all` -- provider v1.9.1
# sends maintenance_mode fields that Render rejects for free services, which
# produced a partial apply. Linking a group sidesteps that entirely: the
# service resource is untouched, and the link is its own resource.
resource "render_env_group" "cache" {
  count = var.enable_key_value ? 1 : 0

  name           = "medinstru-cache-env"
  environment_id = var.environment_id

  env_vars = {
    REDIS_URL = {
      value = render_keyvalue.cache[0].connection_info.internal_connection_string
    }
  }
}

resource "render_env_group_link" "cache_api" {
  count = var.enable_key_value ? 1 : 0

  env_group_id = render_env_group.cache[0].id
  service_ids  = [local.api_service_id]
}
