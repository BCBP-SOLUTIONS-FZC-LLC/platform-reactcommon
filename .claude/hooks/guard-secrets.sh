#!/usr/bin/env bash
# PreToolUse (Bash): keep tokens out of files and out of Claude's context (.claude/CLAUDE.md: the private Go
# modules token is used only via `gh auth token`, as a BuildKit secret or environment variable; never written
# to a file or printed). Blocks: `gh auth token` outside a $(…) capture; echo/printf of a token variable;
# printing the environment (printenv, env); reading .env. Exit 2 blocks and shows the reason to Claude.
# Tested by scripts/lib/claude-hooks.test.ts.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0

block() {
  echo "Blocked: $1" >&2
  exit 2
}

TOKENS='(GO_PRIVATE_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)'

# `gh auth token` prints the token: allowed only as $(gh auth token), handed straight to a variable or command.
bare=$(sed -E 's/\$\([[:space:]]*gh auth token[^)]*\)//g' <<<"$cmd")
# Only where it runs (a line's or a pipeline's command), not where a script or a doc merely names it.
grep -qE '(^|[;&|])[[:space:]]*gh auth token' <<<"$bare" && block "gh auth token prints a token: capture it, e.g. VAR=\"\$(gh auth token)\", and pass it as an environment variable or a BuildKit secret"

while IFS= read -r seg; do
  if grep -qE "(^|[[:space:]])(echo|printf)[[:space:]].*\\\$\{?${TOKENS}" <<<"$seg"; then
    block "printing a token variable puts the token in the transcript"
  fi
  if grep -qE "(^|[[:space:]])printenv([[:space:]]+${TOKENS})?([[:space:]]*$|[[:space:]]*[|>])|(^|[[:space:]])env[[:space:]]*($|[|>])" <<<"$seg"; then
    block "printing the environment shows the tokens in it; read the one variable you need, without its value"
  fi
  if grep -qE '(^|[[:space:]])(cat|less|more|head|tail|bat|nl|strings|xxd|od|grep|sed|awk)[[:space:]]([^|;&]*[[:space:]])?([^[:space:]]*/)?\.env([[:space:]]|$)' <<<"$seg"; then
    block ".env holds local credentials and stays out of the transcript"
  fi
done < <(sed -E 's/(&&|\|\||;)/\n/g' <<<"$bare")
exit 0
