#!/usr/bin/env bash
# Every third-party action in .github/workflows and .github/actions is pinned to a full 40-character
# commit SHA (with the tag in a trailing comment), so a moved or hijacked tag cannot change the
# pipeline. Local actions (./…) and reusable workflows from this organisation pinned by SHA pass;
# anything else fails. Run from the repository root.
set -euo pipefail

status=0
while IFS= read -r line; do
  file=${line%%:*}; rest=${line#*:}; lineno=${rest%%:*}; text=${rest#*:}
  ref=$(sed -E 's/^[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/["'\'']//g' <<<"$text")
  case "$ref" in
    ./*) continue ;;
  esac
  if ! [[ "$ref" =~ @[0-9a-f]{40}$ ]]; then
    echo "::error file=${file},line=${lineno},title=Unpinned action::${ref} is not pinned to a commit SHA — use owner/repo@<40-char sha> # vX.Y.Z"
    status=1
  fi
done < <(grep -RnE '^[[:space:]-]*uses:' .github/workflows .github/actions)

[ "$status" -eq 0 ] && echo "  ✔  every action is pinned to a commit SHA"
exit "$status"
