# platform-reactcommon

Shared TypeScript SDK for React micro-frontends: runtime config, OTel tracing, logging &amp; RUM,
RFC 9457 errors, HTTP client with trace propagation, OIDC session, UI RBAC, MFE loading, i18n/RTL.
Frontend counterpart of platform-gincommon.

The design contract is [`docs/design/frontend-sdk-design.md`](docs/design/frontend-sdk-design.md).
Each subpath is implemented against it, one at a time.

## Packages

| Package | What |
|---|---|
| `@platform/frontend-sdk` | The SDK. Subpath imports only (`@platform/frontend-sdk/core`, …); the root entry throws |
| `@platform/webpack-preset` | Module Federation shared config and CSP-safe output (not implemented yet) |
| `@platform/eslint-plugin` | Lint rules for SDK consumers (not implemented yet) |

## Development

Node 22 (`.nvmrc`) and pnpm (`corepack enable`).

```sh
pnpm install
pnpm verify          # exports map, lint, typecheck, tests, build, API reports, dependency rules
pnpm contracts:sync  # regenerate packages/frontend-sdk/contracts/ from the backend sources
```

- **Subpaths and dependency rules** live in `packages/frontend-sdk/subpaths.json`. The exports map
  (`pnpm exports:sync`), ESLint boundaries and dependency-cruiser are all generated from it. A
  subpath is built and exported once `src/<name>/index.ts` exists.
- **Contracts** (`packages/frontend-sdk/contracts/`) are generated from sibling checkouts of
  platform-gincommon, platform-fastapicommon and platform-interop-tests (plus platform-events and
  platform-pgcommon, to build go-probe) under `PLATFORM_ROOT` (default: the workspace root), at the
  commits pinned in `contracts/sources.json`. Needs `go` on PATH. Never edit them by hand.
- **Public API**: `pnpm api` updates `packages/frontend-sdk/api/<subpath>.api.md`; an API change
  needs a changeset (`pnpm changeset`). Versions are `1.0.0-alpha.N` until the first environment.

## Functional areas

The SDK's 17 subpaths fall into seven areas, each with its own page in [`docs/areas/`](docs/areas/README.md) (recorded as `area` in `packages/frontend-sdk/subpaths.json`):

| Area | Subpaths |
|---|---|
| [Foundation](docs/areas/foundation.md) | `/core`, `/config`, `/problem` |
| [Observability](docs/areas/observability.md) | `/tracing`, `/logging`, `/metrics` |
| [Data access](docs/areas/data-access.md) | `/http` |
| [Identity & access](docs/areas/identity-access.md) | `/auth`, `/authz`, `/storage` |
| [Micro-frontend platform](docs/areas/mfe-platform.md) | `/mfe`, `/flags`, `/nav` (+ `@platform/webpack-preset`) |
| [UI support](docs/areas/ui-support.md) | `/i18n`, `/security` |
| [Developer surface](docs/areas/developer-surface.md) | `/react`, `/testing` (+ `@platform/eslint-plugin`) |

## CI and releases

`.github/` mirrors platform-gincommon's pipeline (same job names and gates; the image jobs map to the
three npm packages).

- **CI** (`ci.yml`, every PR and every push to `main`):
  - `Validate / Test`: every test, with a coverage gate of ≥ 98 % statements of `packages/*/src`.
  - `Validate / Quality`: workflow hygiene, actions pinned by SHA, lockfile, exports, lint, typecheck,
    build, API reports, dependency rules, the example CSP checks and `pnpm audit --prod`.
  - `Validate / Contracts`: generated `contracts/` against the pinned backend commits, and metrics parity.
  - `Package tarballs`: the three `.tgz` files a release ships.
  - `Trivy scan`: dependencies, secrets and config; SARIF goes to the Security tab, plus a CycloneDX SBOM.
  - `Smoke tests`: the packed tarballs, installed into an empty project.
  - `Cross-language compatibility`: platform-interop-tests, including pair 4 with this ref.
  - `PR summary`: one comment on the PR with every result.
- **Changeset check**: a PR that changes a published package adds a `.changeset/*.md` entry.
- **Release** (`release.yml`): the three packages share one version (changesets `fixed`).
  1. In a release PR, run `pnpm changeset version`. It bumps all three packages, writes each
     `CHANGELOG.md` and consumes the changesets. Commit with `pnpm install` if the lockfile changes,
     then merge.
  2. Tag the merge commit `vX.Y.Z` (the version it set; `v1.0.0-alpha.N` during the alpha) and push
     the tag.
  3. `release.yml` verifies the tag (on `main`, all package versions equal to the tag, CHANGELOG
     sections present). It then runs every CI gate at the tag and publishes a **GitHub Release**:
     the tarballs, the SBOM, and `checksums.txt` with its Cosign Sigstore bundle. A tag with a
     pre-release part is marked as a pre-release. There is no npm registry yet.

Secrets: the org secrets `CI_REPO_READ_TOKEN` (sibling checkouts; `PLATFORM_REPOS_TOKEN` overrides it
for the contracts job if set) and `GO_PRIVATE_TOKEN` (interop), as in platform-gincommon.
