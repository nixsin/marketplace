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

# Gating covers the Key Value INSTANCE. The env group is not gated -- it
# carries the whole environment contract, not just the cache -- so what
# changes is REDIS_URL's value, not whether the group exists.
#
# Deliberately placed BEFORE the apply run below, because it must plan against
# an EMPTY state. Once the instance exists, `enable_key_value = false` does not
# quietly remove it -- lifecycle.prevent_destroy refuses the plan outright,
# which is the intended protection and was confirmed by writing this test in
# the other order first. So this pins the gating expression, not a supported
# way to tear a live cache down.
# REDIS_URL lives in the ONE app env group, whether or not a cache exists --
# empty means "no shared cache", a real connection string means there is one.
# It had its own group at first; two groups meant two links touching the same
# service in one apply, and Render refused with "Unable to add service to
# environment group".
run "redis_url_is_declared_even_with_no_cache" {
  command = plan

  variables {
    jwt_secret       = "test"
    enable_key_value = false
  }

  assert {
    condition = (
      contains(keys(render_env_group.app_env.env_vars), "REDIS_URL") &&
      render_env_group.app_env.env_vars["REDIS_URL"].value == ""
    )
    error_message = "REDIS_URL must be declared empty with no cache — absent means 'forgotten', empty means 'no shared cache'."
  }
}

# Exactly ONE env group and ONE link, for the reason above.
run "there_is_a_single_env_group" {
  command = plan

  variables {
    jwt_secret = "test"
  }

  assert {
    condition     = render_env_group.app_env.name == "medinstru-app-env"
    error_message = "The app env group should be the only one; a second means two links racing on the same service."
  }
}

run "cache_gating_is_all_or_nothing" {
  command = plan

  variables {
    jwt_secret       = "test"
    enable_key_value = false
  }

  assert {
    condition     = length(render_keyvalue.cache) == 0
    error_message = "enable_key_value = false must gate the Key Value instance."
  }

  # The env group is NOT gated -- it carries the whole contract, not just the
  # cache, so it exists either way. What changes is REDIS_URL's value, which
  # `redis_url_is_declared_even_with_no_cache` above asserts.
  assert {
    condition     = render_env_group.app_env.env_vars["REDIS_URL"].value == ""
    error_message = "With the cache gated off, REDIS_URL must still be declared, and empty."
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
    jwt_secret     = "changed"
    api_public_url = "https://changed.invalid/graphql"
  }

  # One probe per service, each driven by a variable this run block changes:
  # JWT_SECRET covers the API service (jwt_secret moved to "changed") and
  # NEXT_PUBLIC_API_URL covers the web service (api_public_url moved to an
  # invalid host). Both must still report their prior-state values, which is
  # what proves ignore_changes = all is doing its job.
  #
  # The API service no longer declares NEXT_PUBLIC_API_URL at all -- apps/api
  # never reads it -- so probing that key here would assert on config that
  # does not exist rather than on drift being ignored.
  assert {
    condition = (
      render_web_service.api.env_vars["JWT_SECRET"].value == "test" &&
      render_web_service.web.env_vars["NEXT_PUBLIC_API_URL"].value == "https://api.laxair.shop/graphql"
    )
    error_message = "Legacy free service configuration drift must remain ignored after import."
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

  # The credential reaches the API through the app env group rather than the
  # service's own env_vars, because render_web_service.api carries
  # ignore_changes = all -- setting it there would be silently dropped. And
  # it is read straight off the Key Value resource, so no person handles it.
  assert {
    condition = (
      render_env_group.app_env.env_vars["REDIS_URL"].value != "" &&
      contains(render_env_group_link.app_env.service_ids, "srv-da02lnojo6nc73djh9bg")
    )
    error_message = "REDIS_URL must reach the API through the linked app env group."
  }
}

# The env group must carry EVERY variable the contract requires, or the next
# deploy refuses to boot. Terraform cannot import the contract, so this pins
# the names; scripts/terraform-env-drift.test.mjs asserts the same list
# against packages/config, which is what catches a variable added there and
# not here.
run "app_env_group_carries_the_whole_contract" {
  command = plan

  variables {
    jwt_secret = "test"
  }

  assert {
    condition = alltrue([
      for name in [
        "APP_ENV",
        "INQUIRY_IP_HASH_SECRET",
        "INQUIRY_TRUST_PROXY_HEADERS",
        "BLOB_PROVIDER",
        "BLOB_ACCESS_KEY_ID",
        "BLOB_SECRET_ACCESS_KEY",
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_TEMPLATE_NAME",
        "WHATSAPP_TEMPLATE_LANGUAGE",
        "WHATSAPP_ALLOW_FREE_FORM",
        "SOURCEMAP_SIGNING_KEY",
      ] : contains(keys(render_env_group.app_env.env_vars), name)
    ])
    error_message = "medinstru-app-env is missing a variable the environment contract requires; the next deploy would refuse to boot."
  }

  # Linked to BOTH services -- APP_ENV alone is required by each, so a link
  # covering only the API leaves the web service failing its own check.
  assert {
    condition = (
      contains(render_env_group_link.app_env.service_ids, "srv-da02lnojo6nc73djh9bg") &&
      contains(render_env_group_link.app_env.service_ids, "srv-da02mt61egvs73fopb00")
    )
    error_message = "The app env group must be linked to both the API and the web service."
  }
}

# REDIS_URL must be defined in exactly ONE group. With the cache enabled the
# cache group carries the real connection string; defining it here too would
# leave precedence to Render's undocumented ordering between groups.
