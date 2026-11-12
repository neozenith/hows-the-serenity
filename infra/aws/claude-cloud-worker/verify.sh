#!/usr/bin/env bash
# Live permission check as the ClaudeCloudWorker role. Expects the worker's user keys in
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY and a `ccw` profile (role_arn + credential_source=Environment).
# Run from the repo root:  bash infra/aws/claude-cloud-worker/verify.sh
set -uo pipefail

ACCOUNT=979037402244
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
fail=0

check() { # check <expect: allow|deny> <description> <command...>
	local expect=$1 desc=$2
	shift 2
	local out
	out=$("$@" 2>&1)
	local rc=$?
	local got=allow
	if [ $rc -ne 0 ] && grep -q -E "AccessDenied|not authorized|UnauthorizedOperation" <<<"$out"; then got=deny; fi
	if [ $rc -ne 0 ] && [ $got = allow ]; then got="error: $(tail -1 <<<"$out")"; fi
	if [ "$got" = "$expect" ]; then echo "ok    $expect  $desc"; else echo "FAIL  want $expect, got $got  $desc"; fail=1; fi
}

A=(aws --profile ccw --region ap-southeast-2)
check allow "whoami is the role"            "${A[@]}" sts get-caller-identity
check allow "list buckets"                  "${A[@]}" s3 ls
check allow "list backup bucket objects"    "${A[@]}" s3 ls s3://isochrones-data-backup-979037402244/ --page-size 1
check allow "list ECS clusters"             "${A[@]}" ecs list-clusters
check allow "describe ECR repos"            "${A[@]}" ecr describe-repositories
check allow "list CloudFront distributions" "${A[@]}" cloudfront list-distributions
check allow "list CloudWatch alarms"        "${A[@]}" cloudwatch describe-alarms
check allow "describe VPCs"                 "${A[@]}" ec2 describe-vpcs
check allow "list ACM certs (us-east-1)"    aws --profile ccw --region us-east-1 acm list-certificates
check deny  "read another bucket"           "${A[@]}" s3 ls s3://jpai-aws-lz-tfstate-979037402244/
check deny  "delete backup bucket"          "${A[@]}" s3api delete-bucket --bucket isochrones-data-backup-979037402244
check deny  "create role without boundary"  "${A[@]}" iam create-role --role-name hts-verify-noboundary --assume-role-policy-document "$TRUST"
check deny  "create non-hts role"           "${A[@]}" iam create-role --role-name verify-escalate --assume-role-policy-document "$TRUST" \
	--permissions-boundary "arn:aws:iam::${ACCOUNT}:policy/ClaudeCloudWorkerBoundary"
check deny  "attach admin to own role"      "${A[@]}" iam attach-role-policy --role-name ClaudeCloudWorker --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
check deny  "edit the boundary policy"      "${A[@]}" iam create-policy-version --policy-arn "arn:aws:iam::${ACCOUNT}:policy/ClaudeCloudWorkerBoundary" \
	--policy-document file://infra/aws/claude-cloud-worker/boundary.json
check deny  "create IAM user"               "${A[@]}" iam create-user --user-name verify-escalate

# Serverless
check allow "list Lambda functions"         "${A[@]}" lambda list-functions --max-items 1
check allow "list EventBridge rules"        "${A[@]}" events list-rules --limit 1
check allow "list SQS queues"               "${A[@]}" sqs list-queues
check allow "list SNS topics"               "${A[@]}" sns list-topics
check allow "list DynamoDB tables"          "${A[@]}" dynamodb list-tables
check deny  "create non-hts queue"          "${A[@]}" sqs create-queue --queue-name verify-escalate
check allow "create hts- queue"             "${A[@]}" sqs create-queue --queue-name hts-verify
check allow "delete hts- queue"             "${A[@]}" sqs delete-queue --queue-url "https://sqs.ap-southeast-2.amazonaws.com/${ACCOUNT}/hts-verify"
check deny  "create non-hts table"          "${A[@]}" dynamodb create-table --table-name verify-escalate --billing-mode PAY_PER_REQUEST \
	--attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH

# Round trip: boundaried hts- role can be created and removed.
check allow "create hts- role with boundary" "${A[@]}" iam create-role --role-name hts-verify-boundary --assume-role-policy-document "$TRUST" \
	--permissions-boundary "arn:aws:iam::${ACCOUNT}:policy/ClaudeCloudWorkerBoundary"
check allow "delete that role"              "${A[@]}" iam delete-role --role-name hts-verify-boundary

exit $fail
