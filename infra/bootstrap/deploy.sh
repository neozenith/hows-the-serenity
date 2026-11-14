#!/usr/bin/env bash
# Deploy this repo's bootstrap stacks, then point GitHub Actions at them.
# Run once, by hand, from the repo root, with admin credentials:
#
#   AWS_PROFILE=jp-fullsend bash infra/bootstrap/deploy.sh
#
# Every stack converges, so re-running is safe. Terraform never manages these.
set -euo pipefail

OWNER=neozenith
REPO=hows-the-serenity
REGION=ap-southeast-2
DIR=infra/bootstrap

# The OIDC subject is repo:<owner>/<repo> unless the repo opts into immutable
# ids, in which case it carries numeric ids and must be read from GitHub.
SUBJECT_PREFIX=$(gh api "repos/${OWNER}/${REPO}/actions/oidc/customization/sub" \
	--jq 'if .use_immutable_subject then .sub_claim_prefix else "" end')

deploy() { # deploy <template> <stack-suffix> [extra args...]
	local template=$1 stack="${REPO}-$2"
	shift 2
	echo "== ${stack}"
	aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
		--template-file "${DIR}/${template}" --stack-name "$stack" "$@"
}

deploy tfstate-bucket.yaml tfstate-bucket --parameter-overrides "GitHubRepo=${REPO}"
deploy tfstate-role.yaml tfstate-role --capabilities CAPABILITY_NAMED_IAM \
	--parameter-overrides "GitHubOrg=${OWNER}" "GitHubRepo=${REPO}" "SubjectPrefix=${SUBJECT_PREFIX}"
deploy guardrails.yaml guardrails --capabilities CAPABILITY_NAMED_IAM
deploy deploy-policy.yaml deploy-policy --capabilities CAPABILITY_IAM \
	--parameter-overrides "GitHubRepo=${REPO}"

output() { # output <stack-suffix> <output-key>
	aws cloudformation describe-stacks --region "$REGION" --stack-name "${REPO}-$1" \
		--query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# Repository variables, not secrets: none of these grant anything without the
# OIDC trust, and workflows read them as ${{ vars.* }}.
gh variable set AWS_ROLE_ARN --repo "${OWNER}/${REPO}" --body "$(output tfstate-role RoleArn)"
gh variable set TFSTATE_BUCKET --repo "${OWNER}/${REPO}" --body "$(output tfstate-bucket BucketName)"
gh variable set AWS_REGION --repo "${OWNER}/${REPO}" --body "$REGION"
echo "GitHub variables set on ${OWNER}/${REPO}"
