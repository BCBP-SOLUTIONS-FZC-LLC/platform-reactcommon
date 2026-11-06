#!/usr/bin/env bash
# PreToolUse (Bash): a release tag goes only on a commit that is on origin/main, whose three package versions
# equal the tag, and whose ci.yml run has passed (VERSIONING.md "If a release fails": alpha.4's first tag went
# on a commit before the release PR merged). Pushing every tag (--tags, --follow-tags, --mirror) is refused:
# push a release tag by name. Deleting a tag and listing tags are allowed. Exit 2 blocks the command and shows
# the reason to Claude. `gh` must be logged in (the CI check fails closed). Tested by scripts/lib/claude-hooks.test.ts.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
SEMVER='v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?'

block() {
  echo "Blocked: $1" >&2
  exit 2
}

# A release tag named on its own (after a space, or as refs/tags/…), never inside a branch name (release/v1…).
tag_in() { grep -oE "(^|[[:space:]])(refs/tags/)?${SEMVER}([[:space:]]|$)" <<<"$1" | head -1 | tr -d '[:space:]' | sed 's#^refs/tags/##'; }

check() { # tag, commit-ish
  local tag=$1 rev=$2 version=${1#v} sha got p out
  sha=$(git -C "$root" rev-parse --verify -q "${rev}^{commit}") || block "$tag: '$rev' is not a commit in this repository"
  for p in frontend-sdk webpack-preset eslint-plugin; do
    got=$(git -C "$root" show "$sha:packages/$p/package.json" 2>/dev/null | jq -r '.version // empty')
    [ "$got" = "$version" ] || block "$tag on ${sha:0:7}: packages/$p is ${got:-missing}, not $version. Tag the release PR's merge commit, after it merges (VERSIONING.md, Maintainer release process)."
  done
  git -C "$root" merge-base --is-ancestor "$sha" origin/main 2>/dev/null ||
    block "$tag on ${sha:0:7}: the commit is not on origin/main. Merge the release PR first, then git fetch."
  out=$(cd "$root" && gh run list --workflow ci.yml --commit "$sha" --limit 1 --json status,conclusion -q '.[0] | "\(.status) \(.conclusion)"' 2>&1) ||
    block "$tag: could not check main's CI on ${sha:0:7} with gh ($out)"
  [ "$out" = "completed success" ] || block "$tag: main's CI on ${sha:0:7} has not passed (${out:-no run}). Wait for it, or fix main first."
}

while IFS= read -r seg; do
  case "$seg" in
    *"git tag"*)
      rest=${seg#*git tag}
      [[ "$rest" =~ (^|[[:space:]])(-d|--delete|-l|--list|-v|--verify|-n[0-9]*)([[:space:]]|$) ]] && continue
      tag=$(tag_in "$rest")
      [ -n "$tag" ] || continue
      commit=$(grep -oE '(^|[[:space:]])[0-9a-f]{7,40}([[:space:]]|$)' <<<"$rest" | tail -1 | tr -d '[:space:]')
      check "$tag" "${commit:-HEAD}"
      ;;
    *"git push"*)
      rest=${seg#*git push}
      [[ "$rest" =~ (^|[[:space:]])(--tags|--follow-tags|--mirror)([[:space:]]|$) ]] && block "push a release tag by name (git push origin vX.Y.Z), never every tag"
      [[ "$rest" =~ (--delete|[[:space:]]:refs/tags/|[[:space:]]:v[0-9]) ]] && continue
      tag=$(tag_in "$rest")
      [ -n "$tag" ] || continue
      git -C "$root" rev-parse --verify -q "refs/tags/$tag" >/dev/null || continue # git itself will refuse it
      check "$tag" "refs/tags/$tag"
      ;;
  esac
done < <(sed -E 's/(&&|\|\||;|\|)/\n/g' <<<"$cmd")
exit 0
