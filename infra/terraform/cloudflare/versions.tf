terraform {
  required_version = ">= 1.9.0"

  cloud {
    organization = "nixsin-marketplace"

    workspaces {
      name = "marketplace-cloudflare-production"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
  }
}

provider "cloudflare" {}
