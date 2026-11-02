#!/usr/bin/env bash
# release.yml npm-publish job, before publishing: publishing must be gated. A job that names an
# environment which does not exist gets one created on the spot, unprotected, and runs: the gate
# would silently disappear (VERSIONING.md, "Publishing", one-time setup). Either gate passes:
#
#   reviewers  the `npm` environment requires reviewers (an approval per release). GitHub offers it
#              for public repositories, and for private ones only on Enterprise.
#   tags       on GitHub Team with a private repository: the `npm` environment accepts only release
#              tags (deployment policies of type tag, v…), and an active tag ruleset covering
#              refs/tags/v* blocks creating, moving and deleting them except for its bypass list. Who
#              may push a release tag is who may publish. Its bypass list may name admins
#              (RepositoryRole 5, OrganizationAdmin) and teams only: a write or maintain role, an app or a
#              deploy key there would let others publish. GitHub shows the list only to admins, so with
#              release.yml's token the check warns that it could not see it; run it as an admin to verify
#              (VERSIONING.md).
#
#   REPO      owner/name (default: $GITHUB_REPOSITORY)
#   ENV_NAME  default npm
#   GATE_REF  the release ref a ruleset must cover (default refs/tags/v1.0.0)
# Needs GH_TOKEN with read access to the repository's environments (job permission actions: read).
# Tested by scripts/check-npm-environment.test.ts against a fake gh.
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:?set REPO or GITHUB_REPOSITORY}}"
ENV_NAME="${ENV_NAME:-npm}"
GATE_REF="${GATE_REF:-refs/tags/v1.0.0}"

fail() {
  echo "::error title=npm environment::$1"
  exit 1
}

if ! env_json="$(gh api "repos/${REPO}/environments/${ENV_NAME}" 2>&1)"; then
  fail "cannot read environment '${ENV_NAME}' of ${REPO}: ${env_json}"
fi

# ── Gate 1: required reviewers ─────────────────────────────────────────────────────────────────
reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?] | length' <<<"${env_json}")"
if [ "${reviewers}" -ge 1 ]; then
  echo "  ✔  environment '${ENV_NAME}' requires approval (${reviewers} reviewer(s))"
  exit 0
fi

# ── Gate 2: release tags only, and a ruleset over who may push them ───────────────────────────
how="Either add required reviewers (Settings → Environments → ${ENV_NAME}; public repositories or Enterprise), or limit '${ENV_NAME}' to release tags and protect them with a tag ruleset (VERSIONING.md, \"Publishing\")."

if [ "$(jq -r '.deployment_branch_policy.custom_branch_policies // false' <<<"${env_json}")" != true ]; then
  fail "environment '${ENV_NAME}' of ${REPO} has no required reviewers and accepts any branch or tag: refusing to publish without a gate. ${how}"
fi
if ! policies="$(gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" 2>&1)"; then
  fail "cannot read the deployment policies of '${ENV_NAME}': ${policies}"
fi
bad="$(jq -r '[.branch_policies[]? | select(.type != "tag" or (.name | startswith("v") | not)) | "\(.type // "branch") \(.name)"] | join(", ")' <<<"${policies}")"
count="$(jq '[.branch_policies[]?] | length' <<<"${policies}")"
if [ "${count}" -lt 1 ] || [ -n "${bad}" ]; then
  fail "environment '${ENV_NAME}' must accept only release tags (type tag, v…); it has: ${bad:-no policy}. ${how}"
fi

if ! list="$(gh api "repos/${REPO}/rulesets?targets=tag&includes_parents=true" 2>&1)"; then
  fail "cannot list the rulesets of ${REPO}: ${list}"
fi
covers() { # $1: ruleset JSON → 0 when its ref conditions cover GATE_REF
  local pat
  while IFS= read -r pat; do
    [ -n "${pat}" ] || continue
    # shellcheck disable=SC2053 # the pattern is a glob on purpose
    if [[ "${pat}" == "~ALL" || "${GATE_REF}" == ${pat} ]]; then
      while IFS= read -r pat; do
        [ -n "${pat}" ] || continue
        # shellcheck disable=SC2053
        [[ "${pat}" == "~ALL" || "${GATE_REF}" == ${pat} ]] && return 1
      done < <(jq -r '.conditions.ref_name.exclude[]?' <<<"$1")
      return 0
    fi
  done < <(jq -r '.conditions.ref_name.include[]?' <<<"$1")
  return 1
}
for id in $(jq -r '.[]? | select(.target == "tag" and .enforcement == "active") | .id' <<<"${list}"); do
  rs="$(gh api "repos/${REPO}/rulesets/${id}")" || continue
  [ "$(jq -r '.enforcement' <<<"${rs}")" = active ] || continue
  covers "${rs}" || continue
  missing="$(jq -r '[.rules[]?.type] as $t | ["creation", "update", "deletion"] - $t | join(", ")' <<<"${rs}")"
  [ -z "${missing}" ] || continue
  name="$(jq -r '.name' <<<"${rs}")"
  if [ "$(jq -r 'has("bypass_actors") and .bypass_actors != null' <<<"${rs}")" = true ]; then
    loose="$(jq -r '[.bypass_actors[] | select((.actor_type == "RepositoryRole" and .actor_id == 5) or .actor_type == "OrganizationAdmin" or .actor_type == "Team" | not) | "\(.actor_type) \(.actor_id // "")"] | join(", ")' <<<"${rs}")"
    [ -z "${loose}" ] || fail "ruleset '${name}' (${id}) lets more than admins and named teams push release tags (bypass: ${loose}): anyone in that role could publish. Limit its bypass list to the admin role or a release team."
    echo "  ✔  environment '${ENV_NAME}' accepts only release tags, and ruleset '${name}' (${id}) lets only admins and named teams create, move or delete them"
  else
    echo "::warning title=npm environment::ruleset '${name}' (${id}) protects release tags, but this token cannot see its bypass list. Verify it as a repository admin: REPO=${REPO} bash .github/scripts/check-npm-environment.sh"
    echo "  ✔  environment '${ENV_NAME}' accepts only release tags, and ruleset '${name}' (${id}) restricts who may create, move or delete them"
  fi
  exit 0
done
fail "environment '${ENV_NAME}' of ${REPO} accepts only release tags, but no active tag ruleset covering ${GATE_REF} restricts creating, moving and deleting them: anyone with write access could publish. ${how}"
