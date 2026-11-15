# The worker user, role and policies were first created with the AWS CLI.
# These blocks adopt them into state on the first apply instead of recreating
# them, which would rotate nothing but would break the stored access key's
# trust for a moment. They are no-ops once the resources are in state, and can
# be deleted after the first successful apply.

import {
  to = aws_iam_user.worker
  id = "claudecloudworker"
}

import {
  to = aws_iam_user_policy.worker_assume_only
  id = "claudecloudworker:AssumeClaudeCloudWorkerRoleOnly"
}

import {
  to = aws_iam_role.worker
  id = "ClaudeCloudWorker"
}

import {
  for_each = local.worker_policies
  to       = aws_iam_policy.worker[each.key]
  id       = "arn:aws:iam::${local.account_id}:policy/ClaudeCloudWorker-${each.key}"
}

import {
  for_each = local.worker_policies
  to       = aws_iam_role_policy_attachment.worker[each.key]
  id       = "ClaudeCloudWorker/arn:aws:iam::${local.account_id}:policy/ClaudeCloudWorker-${each.key}"
}
