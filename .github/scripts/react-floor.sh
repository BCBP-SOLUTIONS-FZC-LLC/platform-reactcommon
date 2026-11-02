#!/usr/bin/env bash
# The React floor (pnpm run test-react-floor; CI job react-floor): the peer range is ^19.0.0, and the
# rest of CI runs the lockfile's newest 19.x, so this run forces the lowest version the range allows,
# React 19.0.0 with its types, across the workspace and checks the SDK still typechecks, passes the
# unit suite and builds the examples. pnpm-workspace.yaml and the lockfile are restored afterwards.
set -euo pipefail

REACT_FLOOR="${REACT_FLOOR:-19.0.0}"
TYPES_FLOOR="${TYPES_FLOOR:-19.0.0}"
cd "$(dirname "$0")/../.."

backup="$(mktemp -d)"
cp pnpm-workspace.yaml pnpm-lock.yaml "${backup}/"
restore() {
  cp "${backup}/pnpm-workspace.yaml" "${backup}/pnpm-lock.yaml" .
  pnpm install --frozen-lockfile --silent >/dev/null 2>&1 || true
  rm -rf "${backup}"
}
trap restore EXIT

cat >> pnpm-workspace.yaml <<YAML
overrides:
  react: ${REACT_FLOOR}
  react-dom: ${REACT_FLOOR}
  '@types/react': ${TYPES_FLOOR}
  '@types/react-dom': ${TYPES_FLOOR}
YAML
pnpm install --no-frozen-lockfile --silent

installed="$(node -p "require('react/package.json').version")"
[ "${installed}" = "${REACT_FLOOR}" ] || { echo "::error title=React floor::expected react ${REACT_FLOOR}, got ${installed}"; exit 1; }
echo "React floor: react ${installed}, @types/react $(node -p "require('@types/react/package.json').version")"

pnpm typecheck
pnpm test
pnpm build
pnpm examples:check
