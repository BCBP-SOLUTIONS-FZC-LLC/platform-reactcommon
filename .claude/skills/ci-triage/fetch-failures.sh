#!/usr/bin/env bash
# Collects what a failed GitHub Actions run left: the run's identity, every job's result, the failed steps,
# each failed job's log (cleaned of ANSI and timestamps), the error lines, the Playwright/Vitest summaries,
# and the run's artifacts. Read-only on GitHub.
#   bash .claude/skills/ci-triage/fetch-failures.sh <run id | run URL | job URL> [out dir]
# The out dir defaults to $TMPDIR/ci-triage-<run id>.
set -euo pipefail

arg="${1:?usage: fetch-failures.sh <run id | run URL | job URL> [out dir]}"
run=$(sed -nE 's#.*/actions/runs/([0-9]+).*#\1#p' <<<"$arg")
[ -n "$run" ] || run="$arg"
out="${2:-${TMPDIR:-/tmp}/ci-triage-$run}"
mkdir -p "$out"
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

gh run view "$run" --json name,event,headBranch,headSha,status,conclusion,createdAt,url \
  --jq '"\(.name) · \(.event) · \(.headBranch) @ \(.headSha[0:7]) · \(.status)/\(.conclusion // "-") · \(.createdAt)\n\(.url)"' | tee "$out/run.txt"
echo
gh run view "$run" --json jobs --jq '.jobs[] | "\(.conclusion // .status)\t\(.name)\t\(.databaseId)", (.steps[]? | select(.conclusion == "failure") | "\t  failed step: \(.name)")' | tee "$out/jobs.txt"

clean() { sed -E 's/\x1b\[[0-9;]*m//g; s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//'; }
gh run view "$run" --json jobs --jq '.jobs[] | select(.conclusion == "failure") | "\(.databaseId)\t\(.name)"' |
  while IFS=$'\t' read -r id name; do
    log="$out/job-$id.log"
    gh api "repos/$repo/actions/jobs/$id/logs" 2>/dev/null | clean > "$log" || true
    echo
    echo "=== $name (job $id): $log"
    # Error lines, without the workflow's own `echo "::error …"` source lines.
    grep -nE '##\[error\]|Error:|ERR_[A-Z_]+|FAIL |✘|×|exit code [1-9]|Expected:|Received:|timed out|OUT_OF_MEMORY|Permission denied' "$log" |
      grep -vE 'echo "::error|^\s*[0-9]+:\s*\^' | cut -c1-240 | head -40 || true
    grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run)|Tests +[0-9]+ (passed|failed)|Test Files' "$log" | head -8 || true
  done

echo
if gh run download "$run" -D "$out/artifacts" >/dev/null 2>&1; then
  echo "artifacts: $out/artifacts"; find "$out/artifacts" -maxdepth 2 | head -20
else
  echo "artifacts: none"
fi
