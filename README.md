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
