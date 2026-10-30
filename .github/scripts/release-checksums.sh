#!/usr/bin/env bash
# Publish job: writes checksums.txt over the packed tarballs (after the artifact hand-off), which
# release.yml signs with `cosign sign-blob` and create-github-release.sh attaches.
# Format matches `sha256sum --check checksums.txt`.
set -euo pipefail

shopt -s nullglob
TARBALLS=(platform-*.tgz)
if [ "${#TARBALLS[@]}" -ne 3 ]; then
  echo "::error title=Checksums::expected 3 package tarballs, found ${#TARBALLS[@]} — did the package artifact download?"
  exit 1
fi
sha256sum "${TARBALLS[@]}" sbom.cyclonedx.json > checksums.txt
echo "  ✔  checksums.txt covers ${#TARBALLS[@]} tarballs and the SBOM"
cat checksums.txt
