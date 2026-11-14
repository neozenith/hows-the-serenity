output "site_url" {
  description = "Where the CloudFront copy of the site is served"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_bucket" {
  description = "Bucket the built bundle is synced into"
  value       = aws_s3_bucket.site.id
}

# The deploy workflow invalidates by id, so this output is a workflow input.
output "distribution_id" {
  description = "CloudFront distribution to invalidate after a deploy"
  value       = aws_cloudfront_distribution.site.id
}

output "worker_role_arn" {
  description = "Role Claude cloud sessions assume (profile ccw)"
  value       = aws_iam_role.worker.arn
}
