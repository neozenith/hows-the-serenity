data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Matches the derivation in infra/bootstrap/deploy-policy.yaml. Change one and
  # the GitHub Actions role loses access to the bucket, so change both or neither.
  site_bucket = "${var.project}-site-${local.account_id}"

  # Created by infra/bootstrap/guardrails.yaml, never by Terraform.
  worker_user_ceiling_arn = "arn:aws:iam::${local.account_id}:policy/ClaudeCloudWorkerUserCeiling"
  worker_role_ceiling_arn = "arn:aws:iam::${local.account_id}:policy/ClaudeCloudWorkerCeiling"
}
