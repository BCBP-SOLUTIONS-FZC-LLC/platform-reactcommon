#!/usr/bin/env bash
# Packs the three published packages (after `pnpm build`) into OUT_DIR (default dist-packages/):
# exactly what a registry or the GitHub Release would ship. Fails when a package's tarball lacks
# its built entry points. Writes packages.txt (name@version per line).
set -euo pipefail

OUT_DIR="${OUT_DIR:-dist-packages}"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
OUT_ABS="$(cd "${OUT_DIR}" && pwd)"

: > "${OUT_ABS}/packages.txt"
for dir in packages/frontend-sdk packages/webpack-preset packages/eslint-plugin; do
  name=$(node -p "require('./${dir}/package.json').name")
  version=$(node -p "require('./${dir}/package.json').version")
  test -d "${dir}/dist" || { echo "::error file=${dir}/package.json,title=Pack::${dir}/dist missing — run 'pnpm build' first"; exit 1; }
  (cd "${dir}" && pnpm pack --pack-destination "${OUT_ABS}" >/dev/null)
  echo "${name}@${version}" >> "${OUT_ABS}/packages.txt"
done

# Every tarball must contain package.json and dist/ (an empty `files` list ships nothing).
for tgz in "${OUT_ABS}"/*.tgz; do
  listing=$(tar -tzf "${tgz}")
  for want in package/package.json package/dist/; do
    grep -q "^${want}" <<<"${listing}" || { echo "::error title=Pack::$(basename "${tgz}") has no ${want}"; exit 1; }
  done
done

echo "::group::Packed"
ls -l "${OUT_ABS}"
cat "${OUT_ABS}/packages.txt"
echo "::endgroup::"
