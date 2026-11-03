# Operations

Commands, CI, releases and the Docker suites. The README's *Local development*, *Testing*, *Releases* and *CI* sections and [`VERSIONING.md`](../VERSIONING.md) are the user-facing versions of this.

## Environment

- Node 22 (`.nvmrc`), pnpm 12 via corepack (`packageManager`). `pnpm run setup` once per clone (install + `.githooks/pre-commit`, which runs the fast gates: lockfile, action pins, exports, docs, lint, typecheck, dependency rules).
- Sibling checkouts for contracts and the stack: the workspace root is two levels up (`PLATFORM_ROOT`), IAM repos under `../../../XPertPMS/IAM` (`IAM_ROOT` / `IAM_REPOS_DIR`). They are **read-only** from here; check a pinned commit in a scratch clone, never by moving their HEAD.
- Docker for `test-collector`, the stack, `rules-check` / `dashboards-check` and mermaid rendering.

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | exports:check, docs:check, lint, typecheck, test, build, examples:check, api:check, depcruise |
| `pnpm run ci` | What CI's quality and test gates run, with the coverage gate and the audit |
| `pnpm test` · `pnpm test:coverage` | Vitest (unit, integration, e2e, examples', scripts'); gate 98% statements of `packages/*/src` |
| `pnpm run test-smoke` | The served example builds (or `SMOKE_BASE_URL`) |
| `pnpm run test-browser` (`test-browser-install` once) | Playwright × Chromium, Firefox, WebKit under the production CSP (~30 s) |
| `pnpm run test-react-floor` | Typecheck, unit suite, build, examples on React 19.0.0 |
| `pnpm run test-collector` | `examples/collector` in the Collector image (the version `docker-compose.yml` pins): 2 gateways + 2 aggregators |
| `pnpm run stack-up` · `test-stack` · `stack-down [--purge]` | The integrated stack; `stack-up` builds the IAM images with `GO_PRIVATE_TOKEN` or `gh auth token` (a BuildKit secret, never written); ~16 min of tests |
| `pnpm contracts:sync [--update-pins]` / `contracts:check` | Generated contracts from the pinned commits |
| `pnpm metrics:parity` · `metrics:proposal` | SDK rules vs gincommon `metricslint`; the Tier 1 proposal judged by it |
| `pnpm api` · `exports:sync` · `docs:sync` | Regenerate API reports, exports + SDK facts, generated docs + diagram blocks |
| `pnpm publish:check` | After `.github/scripts/pack-packages.sh`: tarballs publishable, dist-tag |

## CI (`.github/workflows/`)

| Workflow | Runs | Jobs |
|---|---|---|
| `ci.yml` | every PR (any base), pushes to `main` (not Markdown-only) | `validate-test`, `validate-quality`, `validate-contracts`, `package`; then `trivy`, `smoke` (after `validate-test` + `package`) and `interop`, `browser`, `react-floor`, `collector` (after `validate-test`) → `pr-summary` |
| `changelog-check.yml` | PRs touching `packages/*/src`, `packages/*/package.json`, contracts, `subpaths.json` | changeset + CHANGELOG required; a release PR (changesets deleted, or moved into `.changeset/pre/`) needs only the CHANGELOG |
| `release.yml` | `v*` tag (or dispatch from `main`) | `verify` → `ci.yml`'s gates at the tag except `browser` and `collector` → `npm-publish` → `publish` |
| `stack-nightly.yml` | 01:30 UTC; dispatch with `upstream: pinned \| main` | checks out 7 backend repos, `stack-up`, `test-stack`; artifacts on failure; a failing scheduled run opens/updates the "Nightly stack run failing" issue |

**Runners:** the repo is private → 7 GB RAM, 2 cores. The SDK build sets `--max-old-space-size=4096` (the DTS worker ran out of the ~2 GB default). Tests must not depend on speed: bound waits by real time, poll cross-page effects, record engine limits.

**Secrets** (org secrets, no per-repo setup): `CI_REPO_READ_TOKEN` (private checkouts; `PLATFORM_REPOS_TOKEN` overrides), `GO_PRIVATE_TOKEN` (interop; the nightly's IAM image builds). Check `gh api repos/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/actions/organization-secrets` before calling a secret missing.

## Releasing

1. All changes merged to `main`, each with a changeset and an `[Unreleased]` entry.
2. Release PR on `release/vX.Y.Z`: `pnpm run version-packages` (bumps all three, consumes changesets: in pre mode they move to `.changeset/pre/`, + `exports:sync`); CHANGELOG `[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`, new empty `[Unreleased]`, compare links; `pnpm verify`; `pack-packages.sh && pnpm publish:check`. Merge as `chore(release): vX.Y.Z`.
3. Wait for `main`'s CI on the merge commit, then an **admin** pushes `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z` (the "release tags" ruleset blocks everyone else; that push is the approval).
4. `release.yml`: verify (tag on `main`, versions = tag, CHANGELOG section) → gates → `npm-publish` (gate check `check-npm-environment.sh`, GitHub Packages under `alpha`/`rc`/`latest`, provenance attestation, registry integrity re-checked) → GitHub Release (tarballs, SBOM, Cosign-signed `checksums.txt`; pre-release for `-alpha`/`-rc`).

**The publish gate:** GitHub Team has no environment reviewers for private repos. `npm` accepts only `v*.*.*` tags, and the ruleset "release tags" (admins bypass) restricts creating, moving and deleting `refs/tags/v*`. `check-npm-environment.sh` passes on reviewers or on that tag gate; with an admin token it also rejects a bypass list wider than admins and named teams. A re-run skips versions already published with the same integrity.

Released: `v1.0.0-alpha.1` (2026-11-03). Leaving the alpha: `pnpm changeset pre exit`, then a `1.0.0` release PR.

## Pull Requests

PRs target `main` and are squash-merged. For a stack, retarget each PR to `main` before merging it (or merge bottom-up with merge commits); merging into a stacked base branch leaves `main` without the change. Delete merged branches (or enable *Automatically delete head branches*).

## The Integrated Stack (`docker-compose.yml`, `test/stack`)

Keycloak 26 (realms rendered from IAM's `realm-template.json` + the provisioner's mappers, `prepare.mjs`), Envoy (jwt_authn, ext_authz → AuthZ Enrichment), iam-org-membership + seed, go-probe (gincommon), Postgres/PgBouncer, Valkey, floci (S3, CloudFront API, Lambda `/csp-report`, Secrets Manager, WAF API; runs as root for the Docker socket), an edge shim for CloudFront's data-plane gaps, and the Collectors: `otel-gateway` + `otel-aggregator` (the reference config) in front of a file sink (`.state/otel/*.jsonl`). Findings and the run history: [`docs/e2e/integrated-deployment-report.md`](../docs/e2e/integrated-deployment-report.md); known emulator gaps are `E-n` there.
