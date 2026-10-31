#!/usr/bin/env bash
# Enforces minimum statement coverage of packages/*/src (vitest.config.ts limits coverage to the
# three packages' sources), from Vitest's coverage/coverage-summary.json.
set -euo pipefail

THRESHOLD="${COVERAGE_THRESHOLD:-98}"
SUMMARY=coverage/coverage-summary.json

test -f "${SUMMARY}" || {
  echo "::error file=${SUMMARY},title=Coverage gate::${SUMMARY} missing — run 'pnpm test:coverage' before the coverage gate"
  exit 1
}

echo "::group::Coverage report summary"
pct=$(node -p "require('./${SUMMARY}').total.statements.pct")
node -e "const t = require('./${SUMMARY}').total; for (const k of ['statements', 'branches', 'functions', 'lines']) console.log(k.padEnd(11), t[k].pct + '%');"
echo "::endgroup::"

# Emit before the gate check so the value is available even when coverage fails.
echo "pct=${pct}" >> "$GITHUB_OUTPUT"

gate=$(awk -v p="$pct" -v t="$THRESHOLD" 'BEGIN { print (p+0 < t) ? "FAIL" : "OK" }')
if [ "${gate}" = "FAIL" ]; then
  echo "::error file=${SUMMARY},title=Coverage gate::Statement coverage is ${pct}% — below the ${THRESHOLD}% threshold. Run 'pnpm test:coverage' locally and open coverage/index.html to find the gaps."
  exit 1
fi
echo "  ✔  statement coverage ${pct}% ≥ ${THRESHOLD}%"
