#!/usr/bin/env bash
# Create or update the ClaudeCloudWorker managed policies and attach them to the role.
# Idempotent: existing policies get a new default version (oldest non-default pruned at the 5-version cap).
# Run from the repo root with admin credentials:  AWS_PROFILE=jp-fullsend bash infra/aws/claude-cloud-worker/apply.sh
set -euo pipefail

ACCOUNT=979037402244
ROLE=ClaudeCloudWorker
DIR=infra/aws/claude-cloud-worker

upsert_policy() {
	local name=$1 file=$2 arn="arn:aws:iam::${ACCOUNT}:policy/$1"
	if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
		local versions
		versions=$(aws iam list-policy-versions --policy-arn "$arn" \
			--query 'Versions[?!IsDefaultVersion].VersionId' --output text)
		if [ "$(wc -w <<<"$versions")" -ge 4 ]; then
			aws iam delete-policy-version --policy-arn "$arn" --version-id "$(tr '\t' '\n' <<<"$versions" | sort -V | head -1)"
		fi
		aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$file" --set-as-default >/dev/null
		echo "updated  $name"
	else
		aws iam create-policy --policy-name "$name" --policy-document "file://$file" \
			--tags Key=purpose,Value=claude-cloud-sessions Key=project,Value=hows-the-serenity >/dev/null
		echo "created  $name"
	fi
}

# The boundary is referenced by condition, never attached to ClaudeCloudWorker itself.
upsert_policy ClaudeCloudWorkerBoundary "$DIR/boundary.json"

for part in s3 containers serverless observability website iam-delegation; do
	name="ClaudeCloudWorker-${part}"
	upsert_policy "$name" "$DIR/${part}.json"
	aws iam attach-role-policy --role-name "$ROLE" --policy-arn "arn:aws:iam::${ACCOUNT}:policy/${name}"
	echo "attached $name"
done

# Superseded by ClaudeCloudWorker-s3.
if aws iam get-role-policy --role-name "$ROLE" --policy-name S3ListAllMyBuckets >/dev/null 2>&1; then
	aws iam delete-role-policy --role-name "$ROLE" --policy-name S3ListAllMyBuckets
	echo "removed  inline S3ListAllMyBuckets"
fi
