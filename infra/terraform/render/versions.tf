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
    # Generates the secrets nobody should have to hold. A value produced here
    # lives in Terraform state and reaches Render directly — it is never
    # typed, pasted, or written into this repository.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "render" {
  owner_id = var.owner_id
}
