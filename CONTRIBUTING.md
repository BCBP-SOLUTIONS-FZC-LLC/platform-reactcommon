# Contributing

This is an internal shared library for BCBP Solutions platform web apps: the React micro-frontend SDK (`@platform/frontend-sdk`), the Module Federation preset (`@platform/webpack-preset`) and the consumer lint rules (`@platform/eslint-plugin`). This guide covers how to set up a development environment, add a subpath, a lint rule or a contract, write tests, and cut a release.

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
    test/<subpath>/         ← Tests, one folder per subpath, not beside production code
  webpack-preset/           ← platformShared, sharedFor, platformWebpackConfig (+ test/)
  eslint-plugin/            ← Consumer lint rules (src/rules.ts, test/rules.test.ts)
examples/                   ← shell, remote-tenders, cloudfront (built and checked in CI; not deployed)
scripts/                    ← exports, contracts, docs, API reports, metrics parity, example checks
.githooks/pre-commit        ← Local commit gates (`pnpm run install-hooks`)
docs/                       ← design · architecture · lld · areas · observability · problem-details
```

**Dependency rule:** six layers, generated from `subpaths.json` into ESLint and dependency-cruiser:

```
L0 core · problem · authz  →  L1 config · security · storage  →  L2 tracing · logging · metrics
→  L3 http · flags · i18n  →  L4 auth · mfe · nav  →  L5 react · testing
```

A subpath imports only lower subpaths that it lists in `imports`, and only through their `index.ts`. Subpaths never read each other's module state; they share it through the `PlatformRuntime`. Only `/react` and `/testing` import React; only `/tracing`, `/logging` and `/metrics` import OpenTelemetry.

## Adding a new subpath

1. Add the entry to `packages/frontend-sdk/subpaths.json`: `name`, `layer`, `area` (one of the seven functional areas) and the `imports` it needs.
2. Implement it in `packages/frontend-sdk/src/<name>/index.ts`. Only what that file exports is public; put helpers in other files of the folder or in `src/internal/`.
3. Run `pnpm exports:sync`. It regenerates the exports map and the SDK facts in `@platform/webpack-preset` (the shared list) and `@platform/eslint-plugin`. The build and the API reports pick the subpath up automatically.
4. Add tests in `packages/frontend-sdk/test/<name>/`.
5. Run `pnpm build && pnpm api` and commit `api/<name>.api.md`.
6. Run `pnpm docs:sync` (dependency graph, area pages), and describe the subpath in the design doc, the LLD and its `docs/areas/` page.

Adding an export to an existing subpath is steps 2, 4 and 5.

## Adding a metric

- **The SDK's own metrics (Tier 1)** are recorded through the instrument port (`src/internal/instruments.ts`): `/http`, `/mfe` and `/react` never import metric names. The real implementation is a no-op until governance ratifies the names (design doc step 15). Add a method to `PlatformInstruments`, never a direct meter call.
- **A remote's metrics (Tiers 2 and 3)** go through `getDomainMeter` / `getServiceMeter`, which apply gincommon's naming and label rules. A change to those rules must keep `pnpm metrics:parity` green: it checks the SDK against gincommon's `metricslint`.
- Keep label values bounded: labels known to be unbounded (ids, raw paths) are refused with `InvalidMetricError`, and the exporter caps the values per label.

## Adding a lint rule

1. Implement it in `packages/eslint-plugin/src/rules.ts` with the `rule(...)` helper, and register it in `src/index.ts`.
2. Add valid and invalid cases to `packages/eslint-plugin/test/rules.test.ts`.
3. Decide whether it joins `configs.recommended`: a rule added there is a **MAJOR** change for consumers ([VERSIONING.md](VERSIONING.md)).
4. If it relies on SDK facts (subpaths, forbidden headers), read them from the generated `src/generated/` files (`sdk.ts`, `forbidden-headers.ts`) rather than copying them.

## Contracts

The files under `packages/frontend-sdk/contracts/` and `src/internal/generated/` are generated from the backend repos (gincommon, fastapicommon, platform-interop-tests, the IAM services). Never edit them by hand.

```bash
pnpm contracts:sync --update-pins   # move the pins to the sibling checkouts' HEAD and regenerate
pnpm contracts:check                # what CI runs (Validate / Contracts)
pnpm docs:sync                      # generated registry docs
```

Review the diff: a contract change that alters public behaviour (a new problem type, deny code, registry domain or header) needs a changeset and a CHANGELOG entry like any other change.

## Testing requirements

| Kind | Location | Notes |
|------|----------|-------|
| Unit | `packages/*/test/` | Vitest + jsdom; no network. Use fakes (the Keycloak fake, `mockApi`) and fake timers |
| Contract | `packages/frontend-sdk/test/` (fixtures from `contracts/`) | Identity, redaction and problem fixtures shared with Go and Python |
| Build | `packages/webpack-preset/test/`, `pnpm examples:check` | Real webpack builds: container globals, no SDK in remotes, no `eval` |
| Examples | `examples/*/test/` | The shell's IAM ports against the contract cases; the CloudFront CSP and Lambda |
| Interop | CI `interop` job | platform-interop-tests pair 4 at a pinned SHA |

- Statement coverage of `packages/*/src` must stay **≥ 98%** (`pnpm test:coverage`, gated in CI). Don't lower the threshold.
- Don't break the canonical tests listed in the [README](README.md#canonical-tests-do-not-break) (OIDC refresh, header rules, redaction, problem parsing, CSP-safe config, dependency rules).
- A security-relevant change (tokens, headers, redirects, storage, HTML) needs a test that would fail without it.
- Run one test file or test name with `pnpm exec vitest run packages/frontend-sdk/test/http` or `pnpm exec vitest run -t "single-flight"`.

## Linting and API reports

```bash
pnpm lint        # ESLint (with the generated layer rules) on packages and examples
pnpm typecheck
pnpm depcruise   # dependency rules from subpaths.json
pnpm api:check   # fails if a public API changed without an updated api/*.api.md
```

Give new public symbols a TSDoc comment; it ends up in the API report (api-extractor marks the ones without one `(undocumented)`). Never weaken the security rules in the lint config, and never add `eval`, `new Function` or inline script: the SDK runs under `script-src 'self'` with Trusted Types.

## Pull request checklist

- [ ] `pnpm run ci` passes locally (`pnpm verify` + the coverage gate and the audit)
- [ ] New behaviour is covered by tests in `packages/*/test/`; coverage stays ≥ 98%
- [ ] New public symbols have TSDoc comments, and `api/*.api.md` is updated (`pnpm api`)
- [ ] A changeset (`pnpm changeset`) for a change to a published package
- [ ] `CHANGELOG.md` `[Unreleased]` section updated (the *Changelog check* workflow requires both)
- [ ] If public API or behaviour changed: design doc, README and `VERSIONING.md` impact assessed
- [ ] No tokens in storage, no identity headers (`x-user-id`, `x-tenant-id`, …), no production secrets

## Commit style

Use a short imperative subject line (≤ 72 chars). Reference the area (a subpath, a package or `ci` / `docs`):

```
fix(http): stop retrying a POST without an idempotency key
feat(mfe): add the per-attempt remote timeout
docs: describe the workspace switch in the LLD
```

## Cutting a release

See **[VERSIONING.md § Maintainer release process](./VERSIONING.md#maintainer-release-process)** for the full steps. Short version:

1. Open a release PR: `pnpm run version-packages` (`changeset version`, which bumps all three packages and consumes the changesets, then `exports:sync`, which writes the new version into the generated SDK facts), then move the `[Unreleased]` items to a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`.
2. Run `pnpm install` if the lockfile changed, and `pnpm verify`. Merge as `chore(release): vX.Y.Z`.
3. Create and push an annotated tag on the merge commit: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. `release.yml` verifies the tag, reruns every CI gate and creates the GitHub Release (tarballs, SBOM, signed checksums) with the CHANGELOG section as release notes.
5. Notify the shell and remote teams with upgrade notes if MINOR or MAJOR (upgrade the shell first).
