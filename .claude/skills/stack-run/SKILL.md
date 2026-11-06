---
name: stack-run
description: Run the integrated stack (docker-compose.yml - the example shell and remote behind the CloudFront emulation, Keycloak, Envoy with the real IAM services, floci, the two-tier Collector) and its Playwright suite in three engines, then sort each failure into a known cause or a real regression with the evidence, and bring the stack down. Use when a change touches auth, the gateway path, remote loading, the deploy or telemetry, or before a release.
argument-hint: "[optional Playwright filter, e.g. --project=chromium -g sign-out]"
disable-model-invocation: true
---

# /stack-run

Run `test/stack` end to end and report what failed and why. About 15 minutes; never cut it short with a fixed sleep. README § *Running the integrated stack locally* is the reference; each note here is something that went wrong once.

## 0. Preconditions

```bash
docker info --format '{{.ServerVersion}}'          # Docker running
gh auth status                                     # stack-up builds the IAM images from private Go modules
ls "${IAM_ROOT:-../../../XPertPMS/IAM}"/iam-org-membership >/dev/null   # the IAM repositories
docker compose -p reactcommon-e2e ps -q | wc -l    # 0: nothing left from an earlier run (else stack-down first)
```

Port 443 must be free (or set `STACK_HTTPS_PORT` in `.state/stack.env`).

## 1. Up and run, in the background

`stack-up` passes `gh auth token` to BuildKit itself: never print the token or write it to a file. Logs go under `.state/` (ignored). On macOS keep the machine awake: a sleeping Mac turned a 15-minute run into 2.1 hours once.

```bash
caffeinate -i bash -c 'pnpm run stack-up > .state/stack-up.log 2>&1; echo up_exit=$?; tail -3 .state/stack-up.log;
  pnpm run test-stack $ARGUMENTS > .state/stack-test.log 2>&1; echo test_exit=$?;
  grep -E "passed|failed|flaky|skipped|did not run" .state/stack-test.log | tail -6'
```

Run it with `run_in_background` and wait for the notification. `stack-up: ready (https://app.localtest.me)` means the services passed their health checks.

## 2. Sort each failure

Count the summary, not the `✘` marks: `test.fail` tests marked `✘` for documented issues pass the run, and a test that failed once and then passed on retry shows `✘` too. For each test in the final `failed` list:

1. Match its error against [`../ci-triage/known-causes.md`](../ci-triage/known-causes.md) (the *Stack* rows). Known so far:
   - **`[503, 200]` on `/api/v1/me/session-context` (test 1, usually the first engine):** integrated report Issue 12, IAM's cold org-membership lookup. Confirm in `docker compose -p reactcommon-e2e logs authz-enrichment` (`membership rebuild failed, no stale entry available`). Not an SDK bug.
   - **A remote never renders (SRI mismatch):** a bucket from an older run. `stack-down`, then run again.
   - **WebKit "The Internet connection appears to be offline":** the Mac slept.
2. Otherwise collect the evidence before forming a theory:
   - the assertion and the trace: `pnpm exec playwright show-trace test-results/stack/<test>/trace.zip`;
   - the service logs around the failure: `docker compose -p reactcommon-e2e logs <service>` (`edge`, `envoy`, `keycloak`, `authz-enrichment`, `org-membership`, `otel-gateway`);
   - what reached the Collector: `.state/otel/{traces,logs,metrics}.jsonl`.
3. Re-run only that test in one engine to tell flaky from real: `pnpm exec playwright test -c test/stack/playwright.config.ts --project=chromium -g "<title>"`.

A real regression gets a fix with a test (`/ci-triage` step 4 onwards). A new backend finding goes into `docs/e2e/integrated-deployment-report.md` and, if it can recur, a row in `known-causes.md`.

## 3. Down

```bash
pnpm run stack-down
```

Always, unless the user asked to keep the stack up to look at it.

## 4. Report

The final counts (passed, failed, skipped, did not run, duration); each failure with its cause, evidence and owner (SDK, IAM, Platform, harness); and whether the stack is down.
