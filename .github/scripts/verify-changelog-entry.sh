#!/usr/bin/env bash
# Fails the release unless each package's CHANGELOG.md has a section for RELEASE_TAG (written by
# `pnpm changeset version` in the release PR).
set -euo pipefail
: "${RELEASE_TAG:?RELEASE_TAG is required}"
# shellcheck source=.github/scripts/changelog-section.sh
source "$(dirname "$0")/changelog-section.sh"
for CHANGELOG_FILE in packages/frontend-sdk/CHANGELOG.md packages/webpack-preset/CHANGELOG.md packages/eslint-plugin/CHANGELOG.md; do
  if ! changelog_section_version "$RELEASE_TAG" >/dev/null; then
    echo "::error file=${CHANGELOG_FILE}::Missing entry for ${RELEASE_TAG#v} — run 'pnpm changeset version' in a release PR (it adds '## ${RELEASE_TAG#v}')"
    exit 1
  fi
  echo "  ✔  ${CHANGELOG_FILE}: section ${RELEASE_TAG#v} found"
done
