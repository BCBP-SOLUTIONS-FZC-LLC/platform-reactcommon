#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): keep an edited file in the shape the pre-commit gates expect.
#   *.ts / *.tsx / *.mts / *.mjs / *.js   `eslint --fix` (ESLint is this repo's formatter: `pnpm fmt`);
#                                          what it cannot fix is shown to Claude (exit 2) to fix now
#   docs/architecture/mermaid/*.mmd        `pnpm docs:sync`, so ARCHITECTURE.md's diagram block follows its source
# Tested by scripts/lib/claude-hooks.test.ts.
set -uo pipefail

f=$(jq -r '.tool_input.file_path // empty')
[ -n "$f" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$f" in "$root"/*) ;; *) exit 0 ;; esac
rel=${f#"$root"/}
[ -f "$f" ] || exit 0

case "$rel" in
  node_modules/* | */node_modules/* | */dist/* | dist-packages/* | */generated/* | test/browser/.build/* | .state/*) exit 0 ;;
  docs/architecture/mermaid/*.mmd)
    if ! out=$(cd "$root" && pnpm -s docs:sync 2>&1); then
      echo "pnpm docs:sync failed after editing $rel:" >&2
      echo "$out" >&2
      exit 2
    fi
    exit 0 ;;
  *.ts | *.tsx | *.mts | *.mjs | *.js)
    if ! out=$(cd "$root" && pnpm exec eslint --fix --no-warn-ignored "$rel" 2>&1); then
      echo "ESLint problems left in $rel after --fix:" >&2
      echo "$out" >&2
      exit 2
    fi
    exit 0 ;;
esac
exit 0
