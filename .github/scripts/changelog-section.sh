#!/usr/bin/env bash
# Shared helper, sourced by verify-changelog-entry.sh and extract-release-notes.sh: resolves which
# section of a changesets CHANGELOG.md (default packages/frontend-sdk/CHANGELOG.md) documents
# RELEASE_TAG. `changeset version` writes one "## X.Y.Z" heading per version, pre-releases included:
#
#   v1.0.0          → "## 1.0.0"
#   v1.0.0-alpha.3  → "## 1.0.0-alpha.3"
#
# Matching is by exact string (awk), never regex: semver dots must not act as wildcards.

CHANGELOG_FILE="${CHANGELOG_FILE:-packages/frontend-sdk/CHANGELOG.md}"

# changelog_section_version TAG — prints the version whose section documents TAG, or returns 1.
changelog_section_version() {
  local version="${1#v}"
  if awk -v h="## ${version}" '$0 == h { found = 1; exit } END { exit !found }' "$CHANGELOG_FILE" 2>/dev/null; then
    printf '%s\n' "$version"
    return 0
  fi
  return 1
}

# changelog_section_body VERSION [FILE] — prints the section's body (between its heading and the
# next "## " heading), blank-only lines emptied.
changelog_section_body() {
  awk -v h="## $1" '
    $0 == h { found = 1; next }
    found && index($0, "## ") == 1 { exit }
    found { print }
  ' "${2:-$CHANGELOG_FILE}" | sed -e 's/^[[:space:]]*$//'
}
