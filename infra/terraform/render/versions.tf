terraform {
  required_version = ">= 1.9.0"

  cloud {
    organization = "nixsin-marketplace"

    workspaces {
      name = "marketplace-render-production"
    }
  }

  required_providers {
    render = {
      source  = "render-oss/render"
      version = "~> 1.9"
    }
  }
}

provider "render" {
  owner_id = var.owner_id
}
