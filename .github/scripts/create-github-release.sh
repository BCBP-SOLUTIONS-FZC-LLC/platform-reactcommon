#!/usr/bin/env bash
# Creates the GitHub Release for RELEASE_TAG with the three package tarballs, the SBOM, checksums.txt
# and its Cosign Sigstore bundle. A tag with a pre-release part (v1.0.0-alpha.3) is marked as a
# pre-release. checksums.txt is signed by release.yml before this runs.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

shopt -s nullglob
TARBALLS=(platform-*.tgz)
for f in release-notes.md checksums.txt checksums.txt.sigstore.json sbom.cyclonedx.json "${TARBALLS[@]}"; do
  test -f "$f" || {
    echo "::error::Release asset missing: ${f}"
    exit 1
  }
done
[ "${#TARBALLS[@]}" -eq 3 ] || { echo "::error::expected 3 tarballs, found ${#TARBALLS[@]}"; exit 1; }

PRERELEASE_FLAG=()
if grep -q -- '-' <<<"$RELEASE_TAG"; then
  PRERELEASE_FLAG=(--prerelease)
fi

gh release create "$RELEASE_TAG" \
  --verify-tag \
  --title "$RELEASE_TAG" \
  --notes-file release-notes.md \
  "${TARBALLS[@]}" \
  checksums.txt \
  checksums.txt.sigstore.json \
  sbom.cyclonedx.json \
  "${PRERELEASE_FLAG[@]}"
