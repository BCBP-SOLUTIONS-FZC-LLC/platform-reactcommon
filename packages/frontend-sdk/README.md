# @bcbp-solutions-fzc-llc/frontend-sdk

The shared browser SDK for the platform's React micro-frontends: page identity and correlation, Keycloak sign-in (tokens in memory only), the API client, OTLP telemetry, remote loading with SRI, flags, navigation, i18n, sanitised HTML and test helpers.

- **Import a subpath**, never the package root (it throws): `@bcbp-solutions-fzc-llc/frontend-sdk/core`, `/config`, `/problem`, `/tracing`, `/logging`, `/metrics`, `/http`, `/auth`, `/authz`, `/storage`, `/mfe`, `/flags`, `/nav`, `/i18n`, `/security`, `/react`, `/testing`.
- **Requires** Node ≥ 22 to build, React 19 (`^19.0.0`) and `@opentelemetry/api` `~1.10.0` as peers. ESM only.
- **Installs from GitHub Packages** (`@bcbp-solutions-fzc-llc` scope, a token with `read:packages`).
- Released with `@bcbp-solutions-fzc-llc/webpack-preset` and `@bcbp-solutions-fzc-llc/eslint-plugin` under one version.

Documentation (in the repository):

- [README](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/README.md): the API overview and how to integrate a shell and a remote
- [LLD](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/docs/lld/platform-reactcommon-lld.md): the exact behaviour of every subpath
- [CHANGELOG](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/CHANGELOG.md) and [VERSIONING](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/VERSIONING.md)
