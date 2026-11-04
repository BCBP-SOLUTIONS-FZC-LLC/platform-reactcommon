# Versioning and releases

This repository publishes three **npm packages** consumed by the platform's web shell and its remotes:
- `@bcbp-solutions-fzc-llc/frontend-sdk`;
- `@bcbp-solutions-fzc-llc/webpack-preset`;
- `@bcbp-solutions-fzc-llc/eslint-plugin`.

They always share **one version** (changesets `fixed` group). They're released with a **Git tag** `vX.Y.Z` and a GitHub Release carrying the package tarballs, and described in the root [CHANGELOG.md](CHANGELOG.md), one history for all three ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)). Changesets decide the version bump only; they don't write changelogs.

## Semantic versioning (SemVer)

We use [SemVer 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH` (e.g. `1.2.3`). The bump is declared per change in a `.changeset/*.md` file (`pnpm changeset`). The release takes the largest bump among the pending changesets, and applies it to all three packages.

| Bump | When you change | Examples |
|------|------------------|----------|
| **MAJOR** | Breaking change in the **public** API or behaviour | Removed or renamed export from a subpath; changed function signature or type; removed subpath; a `runtime.json` key that becomes required or stricter; changed wire behaviour consumers rely on (headers sent, error classes thrown); a stricter lint rule in `configs.recommended`; a narrower `platformShared` version range |
| **MINOR** | New backward-compatible capability | New subpath or export; new optional `runtime.json` key with a default; new hook; new lint rule outside `configs.recommended`; new `RequestOptions` field |
| **PATCH** | Backward-compatible fix | Bug fix, performance, a contract re-sync that changes no public type, docs-only correction of published behaviour |

### What counts as public API

| In scope (SemVer applies) | Out of scope (may change without MAJOR) |
|---------------------------|----------------------------------------|
| Every export of the 17 SDK subpaths, as recorded in [`packages/frontend-sdk/api/*.api.md`](packages/frontend-sdk/api/) (api-extractor; CI fails on an unreviewed change) | `src/internal/*` and anything not exported from a subpath's `index.ts` |
| The subpath list itself (the exports map) and the package root throwing | Test seams (`set*InternalsForTests`, `resetRuntimeForTests`) |
| The `runtime.json` schema (keys, defaults, validation), see [LLD §12.1](docs/lld/platform-reactcommon-lld.md#121-runtimejson) | The `PlatformRuntime` object's shape on `globalThis` (shared only between copies of the same major) |
| Wire behaviour: headers sent and withheld, the RFC 9457 parsing, the reserved browser-storage keys | `contracts/` and `src/internal/generated/` files (generated; their **effects** on public behaviour are in scope) |
| `@bcbp-solutions-fzc-llc/webpack-preset` exports and the `platformShared` map | `examples/`, `scripts/`, `.github/` |
| `@bcbp-solutions-fzc-llc/eslint-plugin` rule names, options and `configs.recommended` | Log message wording (the catalogue in the LLD is informative) |
| Telemetry field names and the metric names the SDK emits once ratified | `/testing` internals (its exports are in scope: `createTestPlatform`, `mockApi`, `mockProblem`, `renderMetricInventory`) |

Import **subpaths** only (`@bcbp-solutions-fzc-llc/frontend-sdk/http`). The root and deep paths are not API (`@bcbp-solutions-fzc-llc/eslint-plugin` reports both).

### Module Federation and versions

The shell provides the SDK to every remote as a **strict singleton** shared under `^<MAJOR>.0.0-0` (`@bcbp-solutions-fzc-llc/webpack-preset`). So:
- **Across majors:** a remote built for another major fails share negotiation. The failure stays in its `RemoteBoundary`, never breaking the shell. A MAJOR therefore means rebuilding the shell and every remote together.
- **Within a major:** remotes run against **the shell's** SDK version. A remote requires `^<the SDK version it was built against>` (`sharedFor('remote')`), so a remote built on `1.4.0` is refused by a shell on `1.3.x`: the failure stays in its `RemoteBoundary` at share negotiation, never a missing export at run time. Rules: **upgrade the shell first**, then the remotes; **roll the shell back** only to an SDK at or above the newest one any deployed remote was built against.
- **React and the OTel API** are shared the same way, with the ranges in `platformShared` (`react`/`react-dom` `^19.0.0`, `@opentelemetry/api` `~1.10.0`). Narrowing any of them is a MAJOR.

### Supported React versions

**One React major: React 19** (`^19.0.0`, peer and shared range alike).

- **Why one major.** A page runs exactly one React: the shell's, shared to every remote as a strict singleton. A range spanning two majors would let a remote built and tested on one major run on a shell of the other, where it fails inside the page: React 19 removed `ReactDOM.render`, string refs, legacy context and `defaultProps` on function components, and form actions, `use()` and ref-as-a-prop don't exist in React 18. With one major, a remote on the wrong major is refused at share negotiation and shows its `RemoteBoundary` fallback (`reason=incompatible`).
- **Tested at both ends.** CI runs everything on the lockfile's newest 19.x, and the `react-floor` job reruns the typecheck, the unit suite, the build and the example checks on **React 19.0.0** and `@types/react` 19.0.0 (`pnpm run test-react-floor`). The floor of the range is a tested claim.
- **Moving to a new major (policy).** Support the next major alongside the current one only for a stated, dated window:
  1. A minor release widens the range to both majors. Remotes build and test against both (the floor job gains a leg for each).
  2. The shell upgrades once every deployed remote passes on the new major.
  3. A MAJOR release narrows the range to the new major and drops the old one.
- **History.** Until `1.0.0-alpha.1` the range was `^18.3.0 || ^19.0.0`, but nothing ran on React 18, and the reference shell and remote already needed 19 (form actions). It was narrowed during the alpha, when narrowing costs nothing: no frontend is deployed, and the only one in development is on 19.

### Guarantees

- **Pre-release `1.0.0-alpha.N` (current).** The repository is in changesets pre mode (`alpha`), so every release is `1.0.0-alpha.N`, whatever the bump:
  - a breaking change bumps `N` and is listed in the CHANGELOG;
  - nothing is deployed, and the shell and remotes upgrade together;
  - the shell shares the SDK under `^1.0.0-0`, and each remote requires `^<the SDK version it was built against>` (for example `^1.0.0-alpha.3`, which accepts later alphas and every `1.x`).
- **MAJOR `1` (from `1.0.0`, cut with the first end-to-end environment):** we avoid breaking changes within `1.x`. When one is required, we release `2.0.0` and document the migration in the CHANGELOG.
- **MINOR:** safe to upgrade without code changes unless you opt into new features (shell first, see above).
- **PATCH:** drop-in replacement; upgrade recommended for security fixes.
- **No `0.x`:** the packages start at `1.0.0-alpha.0`, never `0.y.z`. A caret range on `0.x` pins the minor, which under `strictVersion` would break every remote on each minor release (design doc §C3 "Versioning").

### Recorded exceptions

None. During the alpha, breaking changes are expected and recorded in the CHANGELOG. For example, `RuntimeConfigSchema`'s type became `z.ZodMiniType` in the change that moved the config schema to `zod/mini`. Exceptions start being recorded here from `1.0.0`.

## Supported releases

| Version | Status | Supported until |
|---------|--------|-----------------|
| `1.0.0-alpha.N` | **Current** pre-release line (first tag: `v1.0.0-alpha.1`; `1.0.0-alpha.0` was never released) | Until `1.0.0` |
| `1.x` | Planned, from `1.0.0` | Active once released |

When a new **MAJOR** line ships, the previous major receives **security fixes only** for six months after the new major's release ([SECURITY.md](SECURITY.md)).

## Consume a release

The packages are published to **GitHub Packages** (the npm registry at `npm.pkg.github.com`), under the organisation's scope:

| Package | For |
|---|---|
| `@bcbp-solutions-fzc-llc/frontend-sdk` | the shell and every remote |
| `@bcbp-solutions-fzc-llc/webpack-preset` | their builds (dev dependency): webpack 5, or Rspack 2 / Rsbuild 2 through its `/rspack` and `/rsbuild` entry points |
| `@bcbp-solutions-fzc-llc/eslint-plugin` | their lint (dev dependency) |

**Why this scope.** GitHub Packages accepts only packages scoped to the GitHub organisation that owns the repository. The earlier `@platform` name couldn't be used anywhere: on npmjs.com the `platform` organisation belongs to a third party (it publishes `@platform/ts`, `@platform/cli`, …). Any install that resolved `@platform/*` from the public registry could therefore have received someone else's code.

**Setup in a consuming repository.** Add an `.npmrc` that maps the scope, so these packages never resolve from the public registry, and authenticate with a token that has `read:packages`:

```ini
@bcbp-solutions-fzc-llc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

- **Developers:** a classic personal access token with `read:packages` (and SSO-authorised for the organisation), exported as `NODE_AUTH_TOKEN`. Alternatively, `gh auth token` after `gh auth refresh -s read:packages`.
- **GitHub Actions:** `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` with `permissions: packages: read`. On each package's settings page (*Manage Actions access*), give the consuming repository read access once.

```bash
pnpm add @bcbp-solutions-fzc-llc/frontend-sdk@1.0.0-alpha.3
pnpm add -D @bcbp-solutions-fzc-llc/webpack-preset@1.0.0-alpha.3 @bcbp-solutions-fzc-llc/eslint-plugin@1.0.0-alpha.3
```

| Pin style | Use when |
|-----------|----------|
| Exact `X.Y.Z-alpha.N` | During the alpha: breaking changes bump `N` |
| `^X.Y.Z` | From `1.0.0` (strict SemVer) |
| The same version for all three packages | Always: they're released together, and `@bcbp-solutions-fzc-llc/webpack-preset` / `@bcbp-solutions-fzc-llc/eslint-plugin` embed facts about the SDK of the same version (its subpaths, the share range, the forbidden headers) |

Dist-tags: a pre-release is published under its identifier (`alpha`, `rc`), and a stable release under `latest`. So `pnpm add @bcbp-solutions-fzc-llc/frontend-sdk` never installs a pre-release by accident.

**Verifying what you install.** Each tarball has a GitHub build-provenance attestation from the release workflow:

```bash
npm pack @bcbp-solutions-fzc-llc/frontend-sdk@1.0.0-alpha.3
gh attestation verify bcbp-solutions-fzc-llc-frontend-sdk-1.0.0-alpha.3.tgz --repo BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon
```

The same tarballs are attached to the GitHub Release, with Cosign-signed `checksums.txt` (see *Verifying a release* in the [README](README.md#cutting-a-release)).

## Publishing

`release.yml`'s `npm-publish` job publishes, after every gate has passed on the tag:

1. **What ships:** the tarballs the `package` job packed once, which `smoke` tested and `publish:check` validated (scope, registry, repository link, one version, no `workspace:` specifiers). `SHA256SUMS`, written when they were packed, is checked before anything is published.
2. **Provenance:** GitHub Packages has no npm provenance, so the job attaches a build-provenance attestation per tarball (`actions/attest-build-provenance`, Sigstore).
3. **Publish:** `npm publish` per tarball with the job's `GITHUB_TOKEN` (`packages: write`) under the dist-tag `publish:check` derived. A version already in the registry is skipped if its integrity equals the tarball's (a re-run after a later failure) and refused otherwise: versions are never overwritten. Afterwards the registry's integrity must equal the tarball's.
4. **Then the GitHub Release** (`publish`), as before. The irreversible registry step comes first, as platform-fastapicommon's PyPI publish does.

**One-time setup** (repository admin):
- Gate the **`npm`** environment (*Settings → Environments*). `npm-publish` refuses to publish unless one of two gates is in place (`.github/scripts/check-npm-environment.sh`): a job that names a missing environment gets an unprotected one created on the spot, so without that check the gate would silently disappear.
  - **Required reviewers** (an approval per release). GitHub offers them for public repositories, and for private ones only on GitHub Enterprise.
  - **The tag gate** (this repository: private, on GitHub Team). The environment accepts only release tags, and a tag ruleset decides who may push them: who may push a `vX.Y.Z` tag is who may publish. There is no separate approval click.
    ```sh
    REPO=BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon
    # 1. npm accepts only release tags
    gh api -X PUT "repos/$REPO/environments/npm" --input - <<'EOF'
    { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
    EOF
    gh api -X POST "repos/$REPO/environments/npm/deployment-branch-policies" -f name='v*.*.*' -f type=tag
    # 2. only repository admins may create, move or delete v* tags
    gh api -X POST "repos/$REPO/rulesets" --input - <<'EOF'
    { "name": "release tags", "target": "tag", "enforcement": "active",
      "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
      "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }],
      "bypass_actors": [{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }] }
    EOF
    # 3. what release.yml checks
    REPO=$REPO bash .github/scripts/check-npm-environment.sh
    ```
    `actor_id` 5 is the repository *Admin* role; list a team (`"actor_type": "Team"`) instead to name the releasers. Under this gate a `workflow_dispatch` from `main` cannot reach `npm` (the environment admits tags only): publish from the tag push, or re-run that run.
- After the first publish, on each package's page (*Package settings*), check that it is linked to this repository (from `repository` in `package.json`), and grant *Actions access* to the repositories that consume it.
- Packages linked to a repository inherit its visibility. **This repository is private, so the packages are private**: installing them needs a token with `read:packages` from someone who can read them, and a consuming repository's workflows need *Actions access* on the package (above). `license` stays `UNLICENSED` while they are private; choose one (platform-fastapicommon publishes as Apache-2.0) before making the repository public. Deleting a version is possible in the UI, but never reuse its number.

Run locally: `pnpm build && bash .github/scripts/pack-packages.sh && pnpm publish:check`. `.github/scripts/npm-publish.sh` takes `DRY_RUN=1`, or `NPM_REGISTRY=<a local registry>` (it was exercised against Verdaccio: a first publish, an idempotent re-run, and a refused different tarball under the same version).

## Maintainer release process

The release workflow (`.github/workflows/release.yml`) automates verification, every CI gate at the tag, signing and the GitHub Release. Your job is to prepare the version commit and push the tag.

1. **Merge** all changes for the release to `main`. Each change to a published package carries a `.changeset/*.md` and a `CHANGELOG.md` entry under `[Unreleased]` (the *Changelog check* workflow enforces both).

2. **Open a release PR** that runs `pnpm run version-packages`:
   ```bash
   pnpm run version-packages   # changeset version (bumps all three, consumes the changesets) + exports:sync
   # exports:sync writes the version into the generated SDK facts (the share range remotes require);
   # without it the release PR fails exports:check
   # CHANGELOG.md: rename [Unreleased] to [X.Y.Z] - YYYY-MM-DD, add an empty [Unreleased] and the compare links
   pnpm install             # if the lockfile changed
   pnpm verify
   ```
   Merge it as `chore(release): vX.Y.Z`.

3. **Create and push an annotated tag on the merge commit.** This triggers the release workflow:
   ```bash
   git tag -a v1.0.0-alpha.1 -m "v1.0.0-alpha.1"
   git push origin v1.0.0-alpha.1
   ```

4. **The release workflow** (triggered by the tag) will:
   - **Verify:**
     - the tag is reachable from `origin/main` (a manual dispatch must start from `main` or the tag);
     - all three package versions equal the tag;
     - `CHANGELOG.md` has the tag's section (`## [1.0.0-alpha.1]`, or the base `## [1.0.0]` for a pre-release tag).
   - **Re-run every CI gate at the tag:** tests with the coverage gate, quality, contracts, package, Trivy, smoke, interop.
   - **Publish:** sign `checksums.txt` (tarballs + SBOM) with Cosign, then create the **[GitHub Release](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/releases)** with that CHANGELOG section as the release notes. A tag with a pre-release part is marked as a pre-release.

5. **Notify consumers** (the shell and remote teams) with upgrade notes. For a MINOR or MAJOR, say which order to upgrade in (shell first).

**Leaving the alpha (`1.0.0`):**
1. `pnpm changeset pre exit`.
2. `pnpm run version-packages`, which sets `1.0.0`, and the `## [1.0.0]` CHANGELOG section.
3. The release PR and the tag `v1.0.0`, as above.

From then on, releases follow plain SemVer.

### Pre-release tags

| Tag pattern | Meaning |
|-------------|---------|
| `v1.0.0-alpha.N` | The current line: integration with the backends, nothing deployed |
| `v1.0.0-rc.N` | Release candidate for `1.0.0` (enter with `pnpm changeset pre enter rc`); not for production unless approved |

## Compatibility matrix

| platform-reactcommon | React / react-dom | `@opentelemetry/api` | Bundler (preset peers, each optional) | ESLint | Node (build) | TypeScript (types built with) |
|--------------------|-------------------|----------------------|---------------------------------------|--------|--------------|-------------------------------|
| `1.0.0-alpha.N` | `^19.0.0` (tested at 19.0.0 and the newest 19.x) | `~1.10.0` (OTel JS 3) | webpack `^5.100.0` · `@rspack/core` `^2.2.0` · `@rsbuild/core` `^2.2.0` | `^9 \|\| ^10` | `≥ 22` | `6.0` |

The SDK targets evergreen browsers (ES2022), with Trusted Types where the browser supports them.

**Backend contracts.** Each release is built against backend commits pinned in [`packages/frontend-sdk/contracts/sources.json`](packages/frontend-sdk/contracts/sources.json). When a pin moves, the release notes say so. Currently:

| Source | Pinned at |
|---|---|
| platform-gincommon | `fbf57c5` (v2.3.0, adds the `portal` domain) |
| platform-fastapicommon | `b0fcdfd` (after #50) |
| platform-interop-tests | `93e3481` (#9, pair 4) |
| platform-events · platform-pgcommon | `d85f6c8` · `9daebf8` (to build go-probe) |
| iam-authz-enrichment · iam-org-membership | `4bea2ea` · `3d17d87` |

A backend change that alters a contract (a new problem type, deny code, registry domain or metric) reaches the SDK only through a reviewed pin move (`pnpm contracts:sync --update-pins`) and a release.

## Related files

| File | Purpose |
|------|---------|
| [CHANGELOG.md](CHANGELOG.md) | User-facing history per version, for all three packages |
| [`.changeset/`](.changeset/) | Pending changes (`*.md`), `config.json` (the `fixed` group), `pre.json` (alpha pre mode) |
| [README.md](README.md#releases) | Release artefacts, cutting and verifying a release |
| [SECURITY.md](SECURITY.md) | Supported versions for security fixes |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | Automated release pipeline |
| [`packages/frontend-sdk/package.json`](packages/frontend-sdk/package.json) | Version, exports map, peer ranges |
| [`packages/webpack-preset/package.json`](packages/webpack-preset/package.json) | `platformShared` pins (React, OTel API) |
