# Known Causes of CI Failures

Each was a real failure in this repository; match the signature before inventing a new theory.

| Signature (job, log) | Cause | Fix that worked |
|---|---|---|
| `Package tarballs` and `Validate / Quality` both fail; `ERR_WORKER_OUT_OF_MEMORY` in `packages/frontend-sdk build` (tsup DTS) | Private-repo runners have 7 GB RAM; Node's default heap there (~2 GB) is too small for the SDK's declaration build | The build script sets `NODE_OPTIONS=--max-old-space-size=4096`. Reproduce locally with `NODE_OPTIONS=--max-old-space-size=2048 pnpm build` |
| `Validate / Quality`: `TS2307 Cannot find module '…/dist/…'` | A typechecked file imports the built `dist/`; Quality typechecks before it builds | Import from `src/` (as the unit tests and `test/stack/helpers.ts` do) |
| `Trivy scan`: `DS-0002 (HIGH): Specify at least 1 USER command` | A Dockerfile (e.g. `docker/go-probe`) runs as root | `USER 65534:65534` in the final stage; check the image still serves as `nobody` |
| `Validate / Test`: `the page never reached the expected state` in `test/e2e/shell.test.tsx` | A wait bounded by fake-clock turns while real work (WebCrypto PKCE, fetch bodies) is slow on 2-core runners | `until()` also yields up to 2 s of real time with the clock held. Reproduce by delaying `crypto.subtle.digest` ~300 ms |
| `Browser tests`: a close/keepalive test sees `0` requests of one signal, or `metrics … via keepalive` | Order or timing of hide/pagehide senders on slow runners; or engine close loss | Senders run through `src/internal/unload` in priority order; reproduce with `--workers=2 --repeat-each=8`; engine limits go in `test/browser/engine-notes.ts` (skip only on them) |
| `Browser tests` (WebKit): another page reads `undefined` right after a `localStorage` write | WebKit propagates storage between pages asynchronously | `expect.poll` the read |
| `Changelog check`: `adds no .changeset/*.md` on a release PR | changesets v3 pre mode **moves** consumed changesets to `.changeset/pre/` (git: `R100`) | The check accepts `D` or a rename into `.changeset/pre/` |
| Nightly: `/csp-report` tests get **502**; floci logs `ContainerLauncher … BindException: Permission denied` | floci (uid 1001) cannot open a Linux host's `root:docker 660` Docker socket; Docker Desktop does not enforce it | floci runs as `user: "0:0"` in `docker-compose.yml` |
| Nightly: test 1 `SyntaxError: Unexpected end of JSON input` at `helpers.ts` | The shell navigates to Keycloak right after PUB-1's answer; Chromium drops the body before Playwright reads it | Read the body with a direct `page.request.get` |
| Nightly or stack: expected-fail tests marked `✘` but the summary says passed | `test.fail` on documented issues (3, 9, E-3/E-4, E-6) | Not a failure: count the summary, not the `✘` marks |
| `Collector config`: `timed out waiting for 6 points of portal_web_app_clicks_total` (and the next test, which reads the same series) | Not found: once on `main` (run 41621781608), green on rerun; didn't reproduce locally in 9 runs, including Collectors limited to 0.1 CPU | Rerun the job. The timeout now prints the points each aggregator wrote and the Collectors' logs: fewer points means a drop (e.g. `delta_to_cumulative` out-of-order), all points late means delivery |
| A PR's checks did not run / a merged PR's change is missing from `main` | A stacked PR was merged into its stacked base, not `main` | Retarget each stacked PR to `main` before merging; land missing work with one PR whose tree is the stack's top |

When none matches: compare with the last green run of the same workflow (same job, `gh run list --workflow <file> --status success --limit 1`), check whether the branch, runner image, Node version or tool versions changed, and reproduce locally before changing code. Add the new signature here once it is understood.
