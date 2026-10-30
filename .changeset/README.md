# Changesets

Every change to the public API of `@platform/frontend-sdk` (an `api/*.api.md` diff) needs a
changeset: `pnpm changeset`. The SDK is published as `1.0.0-alpha.N` until the first end-to-end
environment; breaking changes bump `N` and are listed in the CHANGELOG (design doc §C3
"Versioning"). The repo is already in pre-release mode (`.changeset/pre.json`, tag `alpha`).
