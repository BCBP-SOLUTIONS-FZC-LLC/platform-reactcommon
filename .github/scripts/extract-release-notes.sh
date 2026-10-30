#!/usr/bin/env bash
# Writes release-notes.md: the RELEASE_TAG section of CHANGELOG.md (the repository's single
# history; the three packages share one version), then the install lines and how to verify the
# assets. Structure as platform-gincommon's extract-release-notes.sh.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${REPO:?REPO is required}"

# shellcheck source=.github/scripts/changelog-section.sh
source "$(dirname "$0")/changelog-section.sh"

VERSION="${RELEASE_TAG#v}"
if ! SECTION=$(changelog_section_version "$RELEASE_TAG"); then
  echo "::error file=CHANGELOG.md::Missing entry for ${VERSION}"
  exit 1
fi
# Plain redirects, not `| tee file | true`: under pipefail, `true` exits without reading, tee can
# die of SIGPIPE and fail the whole release.
changelog_section_body "$SECTION" > release-notes.md

if [ ! -s release-notes.md ] || [ -z "$(tr -d '[:space:]' < release-notes.md)" ]; then
  echo "::error file=CHANGELOG.md::Section [${SECTION}] for ${VERSION} is empty"
  exit 1
fi
if [ "$SECTION" != "$VERSION" ]; then
  release_notes_prefix="> Pre-release ${RELEASE_TAG} of ${SECTION}."
fi

{
  if [ -n "${release_notes_prefix:-}" ]; then
    echo "${release_notes_prefix}"
    echo ""
  fi
  cat release-notes.md
  echo ""
  echo "---"
  echo "**Install** (the tarballs attached below; no registry yet):"
  echo ""
  echo '```'
  echo "gh release download ${RELEASE_TAG} --repo ${REPO} --pattern 'platform-*.tgz'"
  echo "pnpm add ./platform-frontend-sdk-${VERSION}.tgz        # shell and remotes"
  echo "pnpm add -D ./platform-webpack-preset-${VERSION}.tgz ./platform-eslint-plugin-${VERSION}.tgz"
  echo '```'
  echo ""
  echo "**Verify:** \`sha256sum --check checksums.txt\`; \`checksums.txt\` is Cosign keyless-signed (bundle: \`checksums.txt.sigstore.json\`):"
  echo ""
  echo '```'
  echo "cosign verify-blob --bundle checksums.txt.sigstore.json \\"
  echo "  --certificate-identity-regexp '^https://github\\.com/${REPO}/\\.github/workflows/release\\.yml@refs/(tags/v.+|heads/main)\$' \\"
  echo "  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt"
  echo '```'
  echo ""
  echo "**SBOM:** \`sbom.cyclonedx.json\` (CycloneDX, Trivy)."
} > release-notes.md.tmp
mv release-notes.md.tmp release-notes.md
cat release-notes.md
