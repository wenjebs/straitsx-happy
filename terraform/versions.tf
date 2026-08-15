terraform {
  required_version = ">= 1.8.0"

  # Values are supplied by GitHub Actions (or `terraform init -backend-config=...`)
  # so each AWS account can own its state bucket without committing account-specific data.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
