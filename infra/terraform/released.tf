# The Claude cloud worker (user claudecloudworker, role ClaudeCloudWorker and
# its ClaudeCloudWorker-* policies) is shared across projects and managed by
# hand with the AWS CLI, outside any IaC. These blocks drop it from this
# project's state WITHOUT destroying it. Delete this file after the apply that
# carries it has run.

removed {
  from = aws_iam_user.worker
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_user_policy.worker_assume_only
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.worker
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_policy.worker
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.worker
  lifecycle {
    destroy = false
  }
}
