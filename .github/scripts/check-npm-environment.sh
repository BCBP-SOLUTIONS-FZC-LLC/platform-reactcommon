#!/usr/bin/env bash
# release.yml npm-publish job, before publishing: the `npm` environment must require reviewers. A job
# that names an environment which does not exist gets one created on the spot, unprotected, and runs:
# the approval gate would silently disappear (VERSIONING.md, "Publishing", one-time setup).
#
#   REPO      owner/name (default: $GITHUB_REPOSITORY)
#   ENV_NAME  default npm
# Needs GH_TOKEN with read access to the repository's environments (job permission actions: read).
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:?set REPO or GITHUB_REPOSITORY}}"
ENV_NAME="${ENV_NAME:-npm}"

if ! json="$(gh api "repos/${REPO}/environments/${ENV_NAME}" 2>&1)"; then
  echo "::error title=npm environment::cannot read environment '${ENV_NAME}' of ${REPO}: ${json}"
  exit 1
fi
reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?] | length' <<<"${json}")"
if [ "${reviewers}" -lt 1 ]; then
  echo "::error title=npm environment::environment '${ENV_NAME}' of ${REPO} has no required reviewers: refusing to publish without an approval. Add reviewers in Settings → Environments → ${ENV_NAME}."
  exit 1
fi
echo "  ✔  environment '${ENV_NAME}' requires approval (${reviewers} reviewer(s))"
