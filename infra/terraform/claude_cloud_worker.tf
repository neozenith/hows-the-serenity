# Claude cloud sessions authenticate as this user with a long-lived key stored
# in the cloud environment's variables, then assume ClaudeCloudWorker.
#
# The key itself is created by hand and never managed here: Terraform state
# and CI logs are no place for a long-lived secret. Both boundaries come from
# infra/bootstrap/guardrails.yaml, and the GitHub Actions role can only change
# these entities' permissions while those boundaries stay attached.

resource "aws_iam_user" "worker" {
  name                 = "claudecloudworker"
  permissions_boundary = local.worker_user_ceiling_arn

  tags = {
    purpose = "claude-cloud-sessions"
  }
}

data "aws_iam_policy_document" "worker_user" {
  statement {
    sid       = "AssumeClaudeCloudWorkerRoleOnly"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.worker.arn]
  }
}

resource "aws_iam_user_policy" "worker_assume_only" {
  name   = "AssumeClaudeCloudWorkerRoleOnly"
  user   = aws_iam_user.worker.name
  policy = data.aws_iam_policy_document.worker_user.json
}

data "aws_iam_policy_document" "worker_trust" {
  statement {
    sid     = "AllowClaudeCloudWorkerUserOnly"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.worker.arn]
    }
  }
}

resource "aws_iam_role" "worker" {
  name                 = "ClaudeCloudWorker"
  description          = "Role assumed by Claude cloud sessions via the claudecloudworker user. Attach task policies here."
  assume_role_policy   = data.aws_iam_policy_document.worker_trust.json
  max_session_duration = 3600
  permissions_boundary = local.worker_role_ceiling_arn

  tags = {
    purpose = "claude-cloud-sessions"
  }
}

# One managed policy per file in policies/. Adding a capability is adding a
# file; the role picks it up on the next apply. The role ceiling still caps it.
locals {
  worker_policies = toset([for f in fileset("${path.module}/policies", "*.json") : trimsuffix(f, ".json")])
}

resource "aws_iam_policy" "worker" {
  for_each = local.worker_policies

  name   = "ClaudeCloudWorker-${each.key}"
  policy = file("${path.module}/policies/${each.key}.json")

  tags = {
    purpose = "claude-cloud-sessions"
  }
}

resource "aws_iam_role_policy_attachment" "worker" {
  for_each = aws_iam_policy.worker

  role       = aws_iam_role.worker.name
  policy_arn = each.value.arn
}
