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
