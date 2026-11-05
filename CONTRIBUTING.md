# Contributing

This is an internal shared library for BCBP Solutions platform web apps: the React micro-frontend SDK (`@bcbp-solutions-fzc-llc/frontend-sdk`), the Module Federation preset (`@bcbp-solutions-fzc-llc/webpack-preset`) and the consumer lint rules (`@bcbp-solutions-fzc-llc/eslint-plugin`). This guide covers how to set up a development environment, add a subpath, a lint rule or a contract, write tests, and cut a release.

## Prerequisites

- Node 22+ (`.nvmrc`)
- pnpm via corepack (`corepack enable`; the version comes from `packageManager` in `package.json`)
- Only to regenerate contracts or run metrics parity: Go, and the sibling repos checked out at the commits pinned in [`packages/frontend-sdk/contracts/sources.json`](packages/frontend-sdk/contracts/sources.json). They're expected two levels up; set `PLATFORM_ROOT` and `IAM_REPOS_DIR` to change that.
- Optional: `actionlint` and `shellcheck` for `.github/`

## Development setup

```bash
git clone https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon
cd platform-reactcommon
corepack enable
pnpm run setup   # pnpm install + copies .githooks/pre-commit into the repository's hooks
pnpm verify      # exports + docs checks, lint, typecheck, tests, build, example checks, API reports, dependency rules
```

The pre-commit hook runs the fast gates (lockfile drift, action SHA pins, generated exports and docs, lint, typecheck, dependency rules) in about 10 s. `pnpm verify` runs the same checks as CI's quality and test gates. `pnpm run ci` adds the coverage gate and the audit. The other commands, including the ones named after gincommon's `make` targets, are listed in the [README](README.md#make-style-commands).

## Project layout

```
packages/
  frontend-sdk/
    src/<subpath>/index.ts  ← Public API of each subpath (consumers import these; SemVer applies)
    src/internal/           ← PlatformRuntime, change events, instrument port, shared helpers (not public)
    src/internal/generated/ ← Generated from contracts/ (never edited)
    contracts/              ← Generated from pinned backend commits (never edited)
    api/<subpath>.api.md    ← api-extractor report: the reviewed public API
    subpaths.json           ← Subpaths, layers, functional areas, allowed imports (single source)
  webpack-preset/           ← platformShared, sharedFor, platformWebpackConfig, ProvideSdkPlugin, SdkVersionPlugin, ChunkIntegrityPlugin; platformRspackConfig (/rspack), pluginPlatform (/rsbuild)
  eslint-plugin/            ← Consumer lint rules (src/rules.ts)
test/                       ← All tests, not beside production code (as platform-gincommon)
  unit/<subpath>/           ← One folder per SDK subpath; unit/sdk, unit/webpack-preset, unit/eslint-plugin
  integration/              ← Several subpaths wired together, in-process
  e2e/                      ← The reference shell and remote booted end to end, in-process
  smoke/                    ← The served example builds, or a deployed shell (SMOKE_BASE_URL)
  browser/                  ← Playwright: Chromium, Firefox, WebKit under the production CSP
  stack/                    ← Playwright against a production-like stack (Keycloak, Envoy + IAM, floci, Collector)
  collector/                ← The reference Collector (examples/collector) in its image (Docker)
  fixtures/                 ← Shared fakes and helpers
  testenv/                  ← Loads .env; sets OBSERVABILITY_DOMAIN, ENVIRONMENT defaults
examples/                   ← shell, remote-tenders, cloudfront, collector (built and checked in CI; not deployed)
scripts/                    ← exports, contracts, docs, API reports, metrics parity and proposal, example checks
monitoring/                 ← Grafana dashboard, Prometheus rules (+ promtool tests), the Tier 1 registry proposal
docker-compose.yml          ← The production-like stack for test/stack (start with `pnpm run stack-up`, not `docker compose up`)
docker/                     ← Its configs: edge shim, Envoy, floci deploy, go-probe, org-membership seed, Collector
.githooks/pre-commit        ← Local commit gates (`pnpm run install-hooks`)
docs/                       ← design · architecture · lld · areas · observability · problem-details
```

**Dependency rule:** six layers, generated from `subpaths.json` into ESLint and dependency-cruiser:

```
L0 core · problem · authz  →  L1 config · security · storage  →  L2 tracing · logging · metrics
→  L3 http · flags · i18n  →  L4 auth · mfe · nav  →  L5 react · testing
```

A subpath imports only lower subpaths that it lists in `imports`, and only through their `index.ts`. Subpaths never read each other's module state; they share it through the `PlatformRuntime`. Only `/react` and `/testing` import React; only `/tracing`, `/logging` and `/metrics` import OpenTelemetry.

## Extending the library

### Adding a new subpath

1. Add the entry to `packages/frontend-sdk/subpaths.json`: `name`, `layer`, `area` (one of the seven functional areas) and the `imports` it needs.
2. Implement it in `packages/frontend-sdk/src/<name>/index.ts`. Only what that file exports is public; put helpers in other files of the folder or in `src/internal/`.
3. Run `pnpm exports:sync`. It regenerates the exports map and the SDK facts in `@bcbp-solutions-fzc-llc/webpack-preset` (the shared list) and `@bcbp-solutions-fzc-llc/eslint-plugin`. The build and the API reports pick the subpath up automatically.
4. Add tests in `test/unit/<name>/` (and to `test/integration` if it changes how subpaths work together).
5. Run `pnpm build && pnpm api` and commit `api/<name>.api.md`.
6. Run `pnpm docs:sync` (dependency graph, area pages), and describe the subpath in the design doc, the LLD and its `docs/areas/` page.

Adding an export to an existing subpath is steps 2, 4 and 5.

### Adding a metric

- **The SDK's own metrics (Tier 1)** are recorded through the instrument port (`src/internal/instruments.ts`): `/http`, `/mfe` and `/react` never import metric names. The real implementation is a no-op until governance ratifies the names (design doc step 15). Add a method to `PlatformInstruments`, never a direct meter call.
- **A remote's metrics (Tiers 2 and 3)** go through `getDomainMeter` / `getServiceMeter`, which apply gincommon's naming and label rules. A change to those rules must keep `pnpm metrics:parity` green: it checks the SDK against gincommon's `metricslint`.
- Keep label values bounded: labels known to be unbounded (ids, raw paths) are refused with `InvalidMetricError`, and the exporter caps the values per label.

### Adding a lint rule

1. Implement it in `packages/eslint-plugin/src/rules.ts` with the `rule(...)` helper, and register it in `src/index.ts`.
2. Add valid and invalid cases to `test/unit/eslint-plugin/rules.test.ts`.
3. Decide whether it joins `configs.recommended`: a rule added there is a **MAJOR** change for consumers ([VERSIONING.md](VERSIONING.md)).
4. If it relies on SDK facts (subpaths, forbidden headers), read them from the generated `src/generated/` files (`sdk.ts`, `forbidden-headers.ts`) rather than copying them.

### Moving a contract pin

The files under `packages/frontend-sdk/contracts/` and `src/internal/generated/` are generated from the backend repos (gincommon, fastapicommon, platform-interop-tests, the IAM services). Never edit them by hand.

```bash
pnpm contracts:sync --update-pins   # move the pins to the sibling checkouts' HEAD and regenerate
pnpm contracts:check                # what CI runs (Validate / Contracts)
pnpm docs:sync                      # generated registry docs
```

Review the diff: a contract change that alters public behaviour (a new problem type, deny code, registry domain or header) needs a changeset and a CHANGELOG entry like any other change.

### Adding a `runtime.json` key

1. Add it to `RuntimeConfig` and the schema in `packages/frontend-sdk/src/config/schema.ts`. Make it **optional, with no default that changes behaviour**: an existing `runtime.json` must still load. A required key, or a stricter rule on an existing one, is breaking.
2. If it holds an origin or URL, apply the same rule as the others (https; http only on a local host, and only in local, dev and test): `environmentIssues` in `runtime-config.ts`.
3. Test it in `test/unit/config/config.test.ts`: accepted and refused values, absent by default, and the environment rule if it applies.
4. Run `pnpm build && pnpm api` (the `RuntimeConfig` type is in `api/config.api.md`), add a **minor** changeset and a CHANGELOG entry that says when a deployed file may set it (only once its pages run the new version: an older SDK refuses the unknown key).
5. Document it in the README's *Runtime configuration* table, LLD §12.1 and the design doc's `RuntimeConfig`.

### Adding a reserved browser storage key

1. Prefix it `@bcbp-solutions-fzc-llc/frontend-sdk:` and declare it next to its owner (as `SIGNED_OUT_KEY` in `/auth`). Never store a token or anything token-like.
2. Decide what clears it: `clearAllAppStorage()` removes only `/storage` values; a reserved key that must not outlive a sign-out is cleared in `logout()` / `switchWorkspace()`.
3. Add it to LLD §12.3 and `.claude/wire-contracts.md`.

### Adding a cross-tab message or a runtime topic

- **Channel messages** (`BroadcastChannel('platform-auth')`) carry a `type` only, never a token, an id or user data. Handle the message in every session state, including `expired` and `loading`, and add a test with two providers.
- **Runtime topics** (`RuntimeTopic` in `src/internal/events.ts`): add the topic, emit it from the owning subpath, and subscribe from the `/react` hook. Update ARCHITECTURE.md § Cross-tab and in-page events.

### Adding an architecture diagram

1. Write `docs/architecture/mermaid/<name>.mmd`, and render-check it with `ghcr.io/mermaid-js/mermaid-cli/mermaid-cli:11.4.2`.
2. Add a `> Source:` line and an empty ```` ```mermaid ```` block to `ARCHITECTURE.md`, and a row to `docs/architecture/README.md`.
3. Run `pnpm docs:sync`: it fills the block, and `docs:check` (CI) fails while a diagram is missing, unlisted or different.

### Adding a build, test or CI environment variable

1. Read it with a default in the script or test that needs it (`test/testenv` for values every suite shares).
2. Add it to the README's *Environment variables* table. A secret is never written to a file or printed: pass it as an environment variable or a BuildKit secret (as `stack-up` does with `gh auth token`).

## Testing requirements

| Kind | Location | Notes |
|------|----------|-------|
| Unit | `test/unit/<subpath>/` | Vitest + jsdom; no network. Use fakes (`test/fixtures`: the Keycloak fake, `mockApi`) and fake timers |
| Integration | `test/integration/` | Several subpaths wired together in-process: bootstrap, auth + http + telemetry, consent, MFE |
| E2E | `test/e2e/` | The reference shell and remote booted end to end in-process |
| Smoke | `test/smoke/` | Optional locally (`pnpm run test-smoke`, after `pnpm build`); the example builds served as CloudFront does, or a deployed shell at `SMOKE_BASE_URL` |
| Contract | `test/unit/` (fixtures from `contracts/`) | Identity, redaction and problem fixtures shared with Go and Python |
| Build | `test/unit/webpack-preset/` (incl. `rspack.test.ts`), `pnpm examples:check` | Real webpack, Rspack and Rsbuild builds: container globals, no SDK in remotes, no `eval` or `Function`, a mixed webpack/Rspack estate |
| Examples | `examples/*/test/` | The shell's IAM ports against the contract cases; the CloudFront CSP and Lambda |
| Browser | `test/browser/` | Playwright in Chromium, Firefox and WebKit (`pnpm run test-browser`): keepalive and tab close, page-lifecycle order, `AbortSignal.any`, Trusted Types, the production CSP, SRI on lazily loaded JS and CSS chunks. Engine limits are recorded in `engine-notes.ts` (skip only on them) |
| Stack | `test/stack/` | The example shell against a production-like deployment (`pnpm run stack-up`, then `pnpm run test-stack`, then `pnpm run stack-down`; needs Docker and `gh auth token` for the IAM images). The stack is `docker-compose.yml` with its configs in `docker/`. Locally, and nightly in CI (`stack-nightly.yml`). Findings: `docs/e2e/integrated-deployment-report.md` |
| Interop | CI `interop` job | platform-interop-tests pair 4 at a pinned SHA |
| React floor | CI `react-floor` job (`pnpm run test-react-floor`) | Typecheck, unit suite, build and example checks on React 19.0.0 |
| ESLint 9 | CI `eslint-9` job (`pnpm run test-eslint-9`) | The eslint-plugin's tests on ESLint 9, the lower major of its peer range (a release gate too) |
| Collector | CI `collector` job (`pnpm run test-collector`) | The reference two-tier Collector in its image (Docker) |

- A security-relevant change (tokens, headers, redirects, storage, HTML) needs a test that would fail without it. Check that it does: revert the fix and run the test.
- A regression test names what it covers (an integrated-report issue, a review item, a known browser bug).
- Run one test file or test name with `pnpm exec vitest run test/unit/http` or `pnpm exec vitest run -t "single-flight"`.

### Canonical test cases

Don't break the tests listed in the [README](README.md#canonical-tests-do-not-break): OIDC refresh (single flight, no refresh-token reuse across tabs or failures, tokens never in storage or the channel), `/http`'s header and token rules, the identity and redaction fixtures shared with Go and Python, problem parsing, a config parse that never builds a `Function`, the dependency rules, the shell's IAM ports against the contract cases, the real webpack, Rspack and Rsbuild builds, and the CloudFront CSP. Change one only together with the invariant it protects, and say so in the PR.

### Coverage gate

`Validate / Test` fails below **98%** statement coverage of `packages/*/src` (`.github/scripts/coverage-gate.sh`), as platform-gincommon. Don't lower the threshold.

```bash
pnpm test:coverage            # text summary; HTML report in coverage/
```

Aim for coverage where it matters (the OIDC state machine, `/http` retries and headers, redaction, the unload budget) rather than lines for their own sake.

### Docker-based suites

`test/collector` and `test/stack` need Docker; `test/stack` also needs `gh auth login` (private Go modules for the IAM images) and the IAM repositories checked out (`IAM_ROOT`). `pnpm test` never starts Docker. Step-by-step: [README § Running the integrated stack locally](README.md#running-the-integrated-stack-locally).

### Timing in tests

CI runs on 2-core runners. Wait on a condition with a real-time bound, never on a fixed number of fake-clock turns. In the browser suite, skip only on an engine limit recorded in `test/browser/engine-notes.ts`.


## Linting and API reports

```bash
pnpm lint        # ESLint (with the generated layer rules) on packages and examples
pnpm typecheck
pnpm depcruise   # dependency rules from subpaths.json
pnpm api:check   # fails if a public API changed without an updated api/*.api.md
```

Give new public symbols a TSDoc comment; it ends up in the API report (api-extractor marks the ones without one `(undocumented)`). Never weaken the security rules in the lint config, and never add `eval`, `new Function` or inline script: the SDK runs under `script-src 'self'` with Trusted Types.

## Guardrails and forbidden patterns

- **No token ever leaves memory.** Not to `localStorage`, `sessionStorage`, the `BroadcastChannel`, a log, a span or a URL. `test/unit/auth/oidc.test.ts` asserts it.
- **The browser never sends identity headers** (`FORBIDDEN_REQUEST_HEADERS`: `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`). The gateway injects them.
- **Never edit generated files** (`packages/frontend-sdk/contracts/`, `src/internal/generated/`, `docs/observability/metric-registry.md`, the embedded diagram blocks). Change the source and run the sync command.
- **CSP-safe always:** no `eval`, `new Function`, inline script or runtime CSS-in-JS; HTML only through `sanitizeHtml`.
- **Unload requests start inside the listener.** Anything sent on `pagehide` is `sendBeacon` / keepalive started synchronously within the shared budget (`onUnload`, LLD §7.5); never `await` before it.
- **A refresh is never retried on an ambiguous answer** (network error, 500, 502, 504, bare 503): Keycloak may already have rotated the token, and reusing it revokes the session.
- **Respect the layers** (`subpaths.json`): no imports upward or into another subpath's files; shared state goes through the `PlatformRuntime`.
- **Sibling repositories are read-only from here** (`../../go/*`, `../../python/*`, the IAM services). Read and build them; check pinned commits in scratch clones.
- **Do not commit `.env`** (ignored), and never write `GO_PRIVATE_TOKEN` or any token to a file.

## Documentation update checklist

| What changed | Update |
|---|---|
| Public API (an `api/*.api.md` diff) | Changeset + CHANGELOG; LLD §5; README API overview; `docs/areas/<area>.md`; `.claude/api-reference.md` (`pnpm docs:sync`) |
| A breaking change | CHANGELOG `### Changed` "**Breaking:**" with the opt-out; README *Upgrading between alpha versions*; VERSIONING.md; LLD §14.2 |
| A `runtime.json` key | README *Runtime configuration*; LLD §12.1; design doc `RuntimeConfig` |
| A storage key, channel message, header or OTLP path | LLD §12.3; `.claude/wire-contracts.md`; ARCHITECTURE.md (Data model, Cross-tab events or Integration touchpoints) |
| A flow (bootstrap, sign-in, refresh, sign-out, remote load) | ARCHITECTURE.md section and its `.mmd`; `.claude/request-flows.md`; LLD §8 |
| A build, test or CI environment variable | README *Environment variables* |
| A CI job or required check | README *CI*; `.claude/operations.md` (required check names never change) |
| An open item opened or closed | LLD §15; `.claude/CLAUDE.md` status |
| A finding from the integrated stack | `docs/e2e/integrated-deployment-report.md`; `.claude/skills/ci-triage/known-causes.md` if it can recur |

## Branch naming

- `feat/<topic>`: a new capability
- `fix/<topic>`: a bug fix
- `docs/<topic>`: documentation only
- `test/<topic>`: tests only
- `chore/<topic>`: dependencies, tooling, CI, refactors with no behavioural change
- `release/vX.Y.Z`: the release PR (`/release` skill)

Branch off the latest `main` and target `main` (squash merges). Don't stack PRs on each other's branches without retargeting each to `main` before it merges.

## Pull request checklist

- [ ] `pnpm run ci` passes locally (`pnpm verify` + the coverage gate and the audit)
- [ ] New behaviour is covered by tests under `test/` (mirroring `src/`); coverage stays ≥ 98%
- [ ] New public symbols have TSDoc comments, and `api/*.api.md` is updated (`pnpm api`)
- [ ] A changeset (`pnpm changeset`) for a change to a published package
- [ ] `CHANGELOG.md` `[Unreleased]` section updated (the *Changelog check* workflow requires both): under a dated topic heading (`### Added (YYYY-MM-DD — topic)`), naming the subpath, files and tests, with *Previously:* for a changed behaviour; update *Known gaps* when you open or close one
- [ ] The documentation update checklist above reviewed
- [ ] For a change to the SDK, the preset or the examples: the `invariant-reviewer` subagent run on the diff; for a change to the public surface or a default: `api-change-reviewer`
- [ ] For a change to auth, unload, CSP or remote loading: `pnpm run test-browser` passes; for one that touches the gateway or deployment path: the integrated stack
- [ ] No tokens in storage, no identity headers (`x-user-id`, `x-tenant-id`, …), no production secrets

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/). Use a short imperative subject line (≤ 72 chars) naming the area (a subpath, a package, or `ci` / `docs` / `build`), and say *why* in the body, with the LLD section or report issue when it helps:

```
fix(auth): retry a refresh only when Keycloak says it was not processed

A 502, 504 or bare 503 may come after Keycloak rotated the refresh token;
retrying with the old one revokes the whole session. 429 and 503 with
Retry-After are safe to retry. (LLD §8.5, review 3.)
```

More subjects:

```
fix(http): stop retrying a POST without an idempotency key
feat(mfe): add the per-attempt remote timeout
feat(config): runtime.json names the environment
docs: describe the workspace switch in the LLD
build(api): write the API reports with LF line endings
```

## Deployment

Nothing in this repository is deployed. It publishes three packages to GitHub Packages (below); each app built with them is deployed by its own pipeline to S3 behind CloudFront, as [`examples/cloudfront`](examples/cloudfront/README.md) and ARCHITECTURE.md § Deployment describe (build once, deploy order, the integrity chain, the headers).

## Cutting a release

See **[VERSIONING.md § Maintainer release process](./VERSIONING.md#maintainer-release-process)** for the full steps. Short version:

1. Open a release PR: `pnpm run version-packages` (`changeset version`, which bumps all three packages and consumes the changesets, then `exports:sync`, which writes the new version into the generated SDK facts), then move the `[Unreleased]` items to a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`.
2. Run `pnpm install` if the lockfile changed, and `pnpm verify`. Merge as `chore(release): vX.Y.Z`.
3. Create and push an annotated tag on the merge commit: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. `release.yml` verifies the tag, reruns every CI gate and creates the GitHub Release (tarballs, SBOM, signed checksums) with the CHANGELOG section as release notes.
5. Notify the shell and remote teams with upgrade notes if MINOR or MAJOR: upgrade the shell first, unless the CHANGELOG says the shell and remotes must upgrade together (as for `1.0.0-alpha.4`'s container global).
