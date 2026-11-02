#!/usr/bin/env bash
# release.yml npm-publish job: publishes the packed tarballs (the package job's artifact, the same files
# smoke tested) to GitHub Packages. Needs node and npm only.
#
#   PKG_DIR       directory with the tarballs, SHA256SUMS and DIST_TAG (default .)
#   NPM_REGISTRY  default https://npm.pkg.github.com (a local registry for a dry run of this script)
#   DRY_RUN=1     npm publish --dry-run; no registry writes
# Auth: setup-node's .npmrc (NODE_AUTH_TOKEN = the job's GITHUB_TOKEN, packages: write).
#
# Idempotent: a version already in the registry is skipped when its integrity equals the tarball's (a
# re-run after a later step failed) and is an error otherwise (a version is never overwritten). After
# publishing, the registry's integrity must equal the tarball's.
set -euo pipefail

REGISTRY="${NPM_REGISTRY:-https://npm.pkg.github.com}"
# The scope's registry too: a project .npmrc scope mapping would otherwise win over --registry.
REG=(--registry "${REGISTRY}" "--@bcbp-solutions-fzc-llc:registry=${REGISTRY}")
cd "${PKG_DIR:-.}"

shopt -s nullglob
TARBALLS=(bcbp-solutions-fzc-llc-*.tgz)
[ "${#TARBALLS[@]}" -eq 3 ] || { echo "::error title=npm publish::expected 3 tarballs, found ${#TARBALLS[@]}"; exit 1; }

# The exact files the package job packed (and smoke tested).
if command -v sha256sum >/dev/null; then sha256sum --check --strict SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi
TAG="$(tr -d '[:space:]' < DIST_TAG)"
[[ "${TAG}" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "::error title=npm publish::bad dist-tag '${TAG}' in DIST_TAG"; exit 1; }

integrity() { node -e 'const c=require("crypto"),f=require("fs");process.stdout.write("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$1"; }

# The registry's integrity for name@version, empty when the version does not exist; any other error stops.
registry_integrity() {
  local out
  if out=$(npm view "$1" dist.integrity "${REG[@]}" 2>&1); then
    printf '%s' "${out}"
  elif grep -qE 'E404|404 Not Found|is not in this registry' <<<"${out}"; then
    printf ''
  else
    echo "::error title=npm publish::npm view $1 failed: ${out}" >&2
    return 1
  fi
}

for tgz in "${TARBALLS[@]}"; do
  manifest="$(tar -xOzf "${tgz}" package/package.json)"
  name="$(node -p 'JSON.parse(process.argv[1]).name' "${manifest}")"
  version="$(node -p 'JSON.parse(process.argv[1]).version' "${manifest}")"
  local_integrity="$(integrity "${tgz}")"

  if [ "${DRY_RUN:-}" = 1 ]; then
    npm publish "./${tgz}" "${REG[@]}" --tag "${TAG}" --dry-run
    continue
  fi

  remote="$(registry_integrity "${name}@${version}")"
  if [ -n "${remote}" ]; then
    if [ "${remote}" = "${local_integrity}" ]; then
      echo "  ✔  ${name}@${version} is already published with this tarball's integrity (re-run): skipped"
      continue
    fi
    echo "::error title=npm publish::${name}@${version} is already published with a different tarball (${remote}); versions are never overwritten"
    exit 1
  fi

  npm publish "./${tgz}" "${REG[@]}" --tag "${TAG}"

  for attempt in 1 2 3 4 5; do
    remote="$(registry_integrity "${name}@${version}")"
    [ -n "${remote}" ] && break
    sleep $((attempt * 2))
  done
  [ "${remote}" = "${local_integrity}" ] || { echo "::error title=npm publish::${name}@${version}: the registry has ${remote:-nothing}, the tarball is ${local_integrity}"; exit 1; }
  echo "  ✔  ${name}@${version} published under dist-tag ${TAG}; registry integrity matches"
done
