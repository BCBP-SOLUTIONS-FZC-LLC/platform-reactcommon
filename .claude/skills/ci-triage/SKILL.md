---
name: ci-triage
description: Diagnose a failed GitHub Actions run of this repository (CI, Changelog check, release, the nightly stack) from its run or job URL - fetch the failed jobs' logs and artifacts, match them against the repository's known failure causes, reproduce locally, and propose the smallest fix with a test. Use when the user reports a failed run, a red check or a failed nightly.
argument-hint: "<run URL | job URL | run id>"
---

# /ci-triage

Find why `$ARGUMENTS` failed, prove it, and fix it at the cause.

## 1. Collect

```bash
bash .claude/skills/ci-triage/fetch-failures.sh "$ARGUMENTS" "<scratchpad>/ci-triage"
```

It prints the run (workflow, event, branch, commit), every job's result with its failed steps, each failed job's error lines and test summaries, and downloads the artifacts (the nightly uploads `test-results/stack/`, `.state/otel`, `.state/logs` and `stack-logs.txt`). The full logs are in the out dir.

Establish first:
- **Which run is it?** Branch and commit: a scheduled nightly on `main` may predate a fix still on a branch, and a run on a stacked branch may lack fixes merged elsewhere.
- **Is it new?** Find the last green run of the same workflow and job, and diff what changed: code, runner image, Node, tool versions, repository visibility (private runners have 7 GB / 2 cores).
- **Real failures vs expected ones:** in Playwright output, `✘` on `test.fail` tests (documented issues) is not a failure; read the summary counts.

## 2. Match

Compare the signature with [`known-causes.md`](known-causes.md). A match is a strong lead, not proof.

## 3. Reproduce before fixing

Reproduce the failure locally in the same conditions, then show the fix removes it:
- memory: `NODE_OPTIONS=--max-old-space-size=2048`;
- slowness: `--workers=2`, `--repeat-each=8`, or a delayed dependency (e.g. `crypto.subtle.digest` +300 ms);
- Linux-only behaviour (Docker socket, file modes): the container's `id`, the floci logs in `stack-logs.txt`.

When it cannot be reproduced, say so and state what the evidence does and does not show; do not present a guess as the cause.

## 4. Fix

- The smallest change at the cause, with a test that fails without it (for a flaky test: show the old version fails under the reproduced condition and the new one passes).
- Test-only fixes stay test-only; product changes get a changeset and a CHANGELOG entry.
- An engine or emulator limit is recorded (`test/browser/engine-notes.ts`, the report's `E-n` table) and skipped only on that condition.
- Add the new signature to `known-causes.md`.
- Fix on the branch the failing PR uses (the lowest affected branch of a stack, then merge upward), or a new branch from `main` for a `main`/nightly failure; push and open the PR only with the user's go-ahead.
