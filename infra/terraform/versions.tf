terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Deliberately partial. The bucket names the account, so it is passed at init:
  #
  #   terraform -chdir=infra/terraform init \
  #     -backend-config="bucket=hows-the-serenity-tfstate-<account-id>" \
  #     -backend-config="region=ap-southeast-2"
  #
  # The workflows read both from repository variables set by
  # infra/bootstrap/deploy.sh. `use_lockfile` is native S3 locking.
  backend "s3" {
    key          = "terraform/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Repo      = var.repo
    }
  }
}
