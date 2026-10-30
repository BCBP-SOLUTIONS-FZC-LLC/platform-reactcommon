#!/usr/bin/env bash
# Writes release-notes.md: the RELEASE_TAG section of each package's CHANGELOG.md (changesets), then
# the install lines and how to verify the assets.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${REPO:?REPO is required}"

# shellcheck source=.github/scripts/changelog-section.sh
source "$(dirname "$0")/changelog-section.sh"

VERSION="${RELEASE_TAG#v}"
{
  for pkg in frontend-sdk webpack-preset eslint-plugin; do
    file="packages/${pkg}/CHANGELOG.md"
    body=$(changelog_section_body "$VERSION" "$file")
    if [ -z "$(tr -d '[:space:]' <<<"$body")" ]; then
      echo "::error file=${file}::Section ${VERSION} is missing or empty" >&2
      exit 1
    fi
    echo "## @platform/${pkg} ${VERSION}"
    echo ""
    # changesets' "### Minor Changes" headings, one level down under the package heading. sed, not
    # ${body//…}: the match is anchored at the start of every line.
    # shellcheck disable=SC2001
    sed -e 's/^### /#### /' <<<"$body"
    echo ""
  done
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
} > release-notes.md
cat release-notes.md
