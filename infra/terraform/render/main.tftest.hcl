mock_provider "render" {
  override_data {
    target = data.render_web_service.existing_api
    values = {
      id   = "srv-da02lnojo6nc73djh9bg"
      name = "medinstru-api"
    }
  }

  override_data {
    target = data.render_web_service.existing_web
    values = {
      id   = "srv-da02mt61egvs73fopb00"
      name = "medinstru-web"
    }
  }
}

# Terraform cannot execute provider imports against a mock. Overriding the
# three permanent-import targets lets an empty test state exercise the same
# addresses without contacting Render.
override_resource {
  target = render_postgres.main
  values = {
    id = "dpg-da02hq7lk1mc73f01hkg-a"
  }
}

override_resource {
  target = render_web_service.api
  values = {
    id = "srv-da02lnojo6nc73djh9bg"
  }
}

override_resource {
  target = render_web_service.web
  values = {
    id = "srv-da02mt61egvs73fopb00"
  }
}

# Gating must be ALL-OR-NOTHING: a half-gated set would leave an env group
# pointing at an instance that does not exist.
#
# Deliberately placed BEFORE the apply run below, because it must plan against
# an EMPTY state. Once the instance exists, `enable_key_value = false` does not
# quietly remove it -- lifecycle.prevent_destroy refuses the plan outright,
# which is the intended protection and was confirmed by writing this test in
# the other order first. So this pins the gating expression, not a supported
# way to tear a live cache down.
run "cache_gating_is_all_or_nothing" {
  command = plan

  variables {
    jwt_secret       = "test"
    enable_key_value = false
  }

  assert {
    condition = (
      length(render_keyvalue.cache) == 0 &&
      length(render_env_group.cache) == 0 &&
      length(render_env_group_link.cache_api) == 0
    )
    error_message = "enable_key_value = false must gate the instance, the env group and the link together."
  }
}

run "adopt_guarded_test_state" {
  command = apply

  variables {
    jwt_secret = "test"
  }

  assert {
    condition = (
      length(render_postgres.main.ip_allow_list) == 1 &&
      tolist(render_postgres.main.ip_allow_list)[0].cidr_block == "0.0.0.0/0" &&
      tolist(render_postgres.main.ip_allow_list)[0].description == "everywhere"
    )
    error_message = "Postgres must retain external access for GitHub Actions migrations."
  }
}

run "free_services_ignore_configuration_drift" {
  command = plan

  variables {
    jwt_secret       = "changed" # scan-ignore: invented, opens nothing
    api_public_url   = "https://changed.invalid/graphql"
    web_service_plan = "standard"
  }

  # The probe is `plan`, because the services no longer declare env_vars at
  # all -- those blocks were inert under ignore_changes and are gone. A field
  # that still exists is needed to show the freeze working, and `plan` is the
  # one whose accidental change would be most expensive: it is a paid
  # upgrade.
  assert {
    condition = (
      render_web_service.api.plan != "standard" &&
      render_web_service.web.plan != "standard"
    )
    error_message = "Legacy free service configuration drift must remain ignored after import; a plan change must never reach Render."
  }

  # AND THE COMPLEMENT, which is the whole architecture: the env groups are
  # NOT frozen, so the same run that cannot change a service does change what
  # the service receives. Without this the freeze and the delivery could both
  # be broken and only one of them noticed.
  assert {
    condition     = render_env_group.web.env_vars["NEXT_PUBLIC_API_URL"].value == "https://changed.invalid/graphql"
    error_message = "The env group must track its variables; if it were frozen too, nothing would deliver."
  }
}

run "missing_api_service_fails_closed" {
  command = plan

  variables {
    jwt_secret = "test"
  }

  override_data {
    target = data.render_web_service.existing_api
    values = {
      name = "missing-api-service"
    }
  }

  expect_failures = [render_web_service.api]
}

run "missing_web_service_fails_closed" {
  command = plan

  variables {
    jwt_secret = "test"
  }

  override_data {
    target = data.render_web_service.existing_web
    values = {
      name = "missing-web-service"
    }
  }

  expect_failures = [render_web_service.web]
}

# The cache defaults must stay FREE and NON-PERSISTENT together. Render's free
# Key Value plan does not offer persistence, so a default of journal_snapshot
# would be refused at apply time -- a failure that only shows up against real
# Render, long after `terraform validate` has passed. These assertions are the
# only thing standing between a plausible-looking edit and that.
run "cache_defaults_are_free_and_non_persistent" {
  command = plan

  variables {
    jwt_secret = "test"
  }

  assert {
    condition = (
      length(render_keyvalue.cache) == 1 &&
      render_keyvalue.cache[0].plan == "free" &&
      render_keyvalue.cache[0].persistence_mode == "off"
    )
    error_message = "Key Value must default to the free plan with persistence off; free Render Key Value refuses persistence and the apply would fail."
  }

  # The credential reaches the API through an env group rather than the
  # service's own env_vars, because render_web_service.api carries
  # ignore_changes = all -- setting it there would be silently dropped.
  assert {
    condition = (
      length(render_env_group.cache) == 1 &&
      length(render_env_group_link.cache_api) == 1 &&
      contains(render_env_group_link.cache_api[0].service_ids, "srv-da02lnojo6nc73djh9bg")
    )
    error_message = "REDIS_URL must be delivered to the API service via a linked env group."
  }
}

# The contract's variables reach the services, and the secrets stay where
# they belong. scripts/terraform-env-drift.test.mjs checks that the NAMES
# match the contract; this checks the wiring Terraform itself controls.
run "contract_variables_are_delivered_to_both_services" {
  command = plan

  variables {
    jwt_secret = "a-supplied-production-secret-value" # scan-ignore: invented, opens nothing
  }

  # Linked, not set on the service. Both web services carry
  # ignore_changes = all, so env_vars written there are applied never.
  assert {
    condition = (
      contains(render_env_group_link.api.service_ids, local.api_service_id) &&
      contains(render_env_group_link.web.service_ids, local.web_service_id)
    )
    error_message = "Each env group must be linked to its own service, or nothing is delivered."
  }

  # The API talks to Postgres over the internal network. The external string
  # exists for connecting from a laptop, which is not what the API is doing.
  assert {
    condition = strcontains(
      render_env_group.api.env_vars["DATABASE_URL"].value,
      "internal"
      ) || !strcontains(
      render_env_group.api.env_vars["DATABASE_URL"].value,
      "external"
    )
    error_message = "DATABASE_URL must be the internal connection string."
  }

  # Free-form WhatsApp is refused in production by the contract: every
  # message here is business-initiated, so the 24h window is never open.
  assert {
    condition     = render_env_group.api.env_vars["WHATSAPP_ALLOW_FREE_FORM"].value == "false"
    error_message = "WHATSAPP_ALLOW_FREE_FORM must be false on Render; Meta rejects every free-form send here."
  }

  # Proxy-header trust defaults OFF. Enabling it asserts the origin refuses
  # traffic that did not come through Cloudflare, which is not yet true.
  assert {
    condition     = render_env_group.api.env_vars["INQUIRY_TRUST_PROXY_HEADERS"].value == "false"
    error_message = "INQUIRY_TRUST_PROXY_HEADERS must default to false while the origin still answers directly."
  }

  # The CONFIGURED length, not the generated result. A password's `result` is
  # computed at apply time, so in a plan-only run it is unknown and the
  # assertion could not enforce anything -- it would have passed whatever the
  # configuration said.
  assert {
    condition = (
      random_password.inquiry_ip_hash_secret.length >= 32 &&
      random_password.sourcemap_signing_key.length >= 32
    )
    error_message = "Generated secrets must be at least 32 characters; the contract refuses shorter ones."
  }
}

run "blob_provider_only_accepts_known_backends" {
  command = plan

  variables {
    jwt_secret    = "a-supplied-production-secret-value" # scan-ignore: invented, opens nothing
    blob_provider = "not-a-backend"
  }

  expect_failures = [var.blob_provider]
}
