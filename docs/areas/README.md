# The SDK by functional area

`@platform/frontend-sdk` has 17 subpaths. By function they fall into seven areas. Each area is documented on its own page: what it's for, its subpaths and main exports, how to use it, and what it guarantees.

The areas are recorded in [`packages/frontend-sdk/subpaths.json`](../../packages/frontend-sdk/subpaths.json) (`areas`, and `area` on every subpath), next to the layers and import rules. `pnpm test` checks that every subpath has an area and that each area's page covers its subpaths. An area is about documentation and ownership; it changes no dependency rule. The rules are the layers in the same file (design doc §C1 "Dependency rules").

| Area | Subpaths | Purpose |
|---|---|---|
| [Foundation](foundation.md) | `/core`, `/config`, `/problem` | Page identity, consent, session id, runtime config and the RFC 9457 error model: what every other area stands on |
| [Observability](observability.md) | `/tracing`, `/logging`, `/metrics` | Traces, logs and metrics over OTLP to `/otel`, correlated, redacted and consent-gated, with the platform registry's rules |
| [Data access](data-access.md) | `/http` | The `ApiClient`: route templates, correlation headers, retries, 401 refresh, de-duplication and problems |
| [Identity & access](identity-access.md) | `/auth`, `/authz`, `/storage` | Keycloak sign-in, workspaces and sessions, UI permissions, per-tenant browser storage |
| [Micro-frontend platform](mfe-platform.md) | `/mfe`, `/flags`, `/nav` | Loading remotes, kill switches and feature flags, cross-app navigation, new-version detection |
| [UI support](ui-support.md) | `/i18n`, `/security` | Translations, locale and direction, formatting; HTML sanitizing and the Trusted Types policy |
| [Developer surface](developer-surface.md) | `/react`, `/testing` | React hooks, providers and error boundaries over every area, and the test kit |

How they build on each other:

```
Developer surface  (/react, /testing)
      │ uses every area below
Micro-frontend platform   Identity & access   UI support
      │                        │                  │
      └──────────── Data access (/http) ──────────┘
                           │
                    Observability
                           │
                       Foundation
```

The two build-time packages belong with the areas they serve: `@platform/webpack-preset` with the micro-frontend platform, and `@platform/eslint-plugin` with the developer surface.
