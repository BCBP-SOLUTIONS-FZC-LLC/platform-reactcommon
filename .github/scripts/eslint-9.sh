#!/usr/bin/env bash
# ESLint 9 (pnpm run test-eslint-9; CI job eslint-9): @bcbp-solutions-fzc-llc/eslint-plugin's peer range is
# ^9.0.0 || ^10.0.0, and the rest of CI runs the lockfile's ESLint 10, so this run forces ESLint 9 across
# the workspace and runs the plugin's tests (every rule through RuleTester, configs.recommended through
# Linter) against it. pnpm-workspace.yaml and the lockfile are restored afterwards.
set -euo pipefail

ESLINT_9="${ESLINT_9:-^9.39.0}"
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
  eslint: '${ESLINT_9}'
YAML
pnpm install --no-frozen-lockfile --silent

installed="$(node -p "require('eslint/package.json').version")"
case "${installed}" in
  9.*) ;;
  *) echo "::error title=ESLint 9::expected eslint 9.x, got ${installed}"; exit 1 ;;
esac
echo "ESLint 9: eslint ${installed}"

pnpm exec vitest run test/unit/eslint-plugin
