# Versioning and releases

This repository publishes three **npm packages** consumed by the platform's web shell and its remotes:
- `@platform/frontend-sdk`;
- `@platform/webpack-preset`;
- `@platform/eslint-plugin`.

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
| `@platform/webpack-preset` exports and the `platformShared` map | `examples/`, `scripts/`, `.github/` |
| `@platform/eslint-plugin` rule names, options and `configs.recommended` | Log message wording (the catalogue in the LLD is informative) |
| Telemetry field names and the metric names the SDK emits once ratified | `/testing` internals (its exports are in scope: `createTestPlatform`, `mockApi`, `mockProblem`, `renderMetricInventory`) |

Import **subpaths** only (`@platform/frontend-sdk/http`). The root and deep paths are not API (`@platform/eslint-plugin` reports both).

### Module Federation and versions

The shell provides the SDK to every remote as a **strict singleton** shared under `^<MAJOR>.0.0-0` (`@platform/webpack-preset`). So:
- **Across majors:** a remote built for another major fails share negotiation. The failure stays in its `RemoteBoundary`, never breaking the shell. A MAJOR therefore means rebuilding the shell and every remote together.
- **Within a major:** remotes run against **the shell's** SDK version. A remote that uses an export added in `1.4.0` needs a shell on `≥ 1.4.0`. Rule: **upgrade the shell first**, then the remotes.
- **React and the OTel API** are shared the same way, with the ranges in `platformShared` (`react`/`react-dom` `^18.3.0 || ^19.0.0`, `@opentelemetry/api` `~1.10.0`). Narrowing any of them is a MAJOR.

### Guarantees

- **Pre-release `1.0.0-alpha.N` (current).** The repository is in changesets pre mode (`alpha`), so every release is `1.0.0-alpha.N`, whatever the bump:
  - a breaking change bumps `N` and is listed in the CHANGELOG;
  - nothing is deployed, and the shell and remotes upgrade together;
  - remotes share the SDK under `^1.0.0-0`, which accepts every alpha and every later `1.x`.
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

There's no npm registry yet. The packages are attached to each GitHub Release:

```bash
gh release download v1.0.0-alpha.1 --repo BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon --pattern 'platform-*.tgz'
pnpm add ./platform-frontend-sdk-1.0.0-alpha.1.tgz                     # shell and remotes
pnpm add -D ./platform-webpack-preset-1.0.0-alpha.1.tgz ./platform-eslint-plugin-1.0.0-alpha.1.tgz
```

Verify the download first: `checksums.txt` is Cosign-signed; see *Verifying a release* in the [README](README.md#cutting-a-release).

| Pin style | Use when |
|-----------|----------|
| Exact version (the tarball for `X.Y.Z`) | Always: without a registry there are no ranges to resolve; commit the tarball or a lockfile entry that points at it |
| The same `X.Y.Z` for all three packages | Always: they're released together, and `@platform/webpack-preset` / `@platform/eslint-plugin` embed facts about the SDK of the same version (its subpaths, the share range, the forbidden headers) |

When a registry is chosen, this table gains the usual `^X.Y.Z` ranges. Release pipelines change only in `publish`.

## Maintainer release process

The release workflow (`.github/workflows/release.yml`) automates verification, every CI gate at the tag, signing and the GitHub Release. Your job is to prepare the version commit and push the tag.

1. **Merge** all changes for the release to `main`. Each change to a published package carries a `.changeset/*.md` and a `CHANGELOG.md` entry under `[Unreleased]` (the *Changelog check* workflow enforces both).

2. **Open a release PR** that runs `pnpm changeset version`:
   ```bash
   pnpm changeset version   # bumps all three packages, consumes the changesets
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
2. `pnpm changeset version`, which sets `1.0.0`, and the `## [1.0.0]` CHANGELOG section.
3. The release PR and the tag `v1.0.0`, as above.

From then on, releases follow plain SemVer.

### Pre-release tags

| Tag pattern | Meaning |
|-------------|---------|
| `v1.0.0-alpha.N` | The current line: integration with the backends, nothing deployed |
| `v1.0.0-rc.N` | Release candidate for `1.0.0` (enter with `pnpm changeset pre enter rc`); not for production unless approved |

## Compatibility matrix

| platform-reactcommon | React / react-dom | `@opentelemetry/api` | webpack | ESLint | Node (build) | TypeScript (types built with) |
|--------------------|-------------------|----------------------|---------|--------|--------------|-------------------------------|
| `1.0.0-alpha.N` | `^18.3.0 \|\| ^19.0.0` | `~1.10.0` (OTel JS 3) | `^5.100.0` | `^9 \|\| ^10` | `≥ 22` | `6.0` |

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
