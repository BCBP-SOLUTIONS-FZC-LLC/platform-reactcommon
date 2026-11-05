# Architecture

The narrative with diagrams is [`ARCHITECTURE.md`](../ARCHITECTURE.md); exact behaviour, the runtime inventory and the log catalogue are in the [LLD](../docs/lld/platform-reactcommon-lld.md); the decisions behind them in [`docs/design/frontend-sdk-design.md`](../docs/design/frontend-sdk-design.md). This file is the map.

## Repository Layout

```
platform-reactcommon/
├── packages/
│   ├── frontend-sdk/                 @bcbp-solutions-fzc-llc/frontend-sdk
│   │   ├── src/<subpath>/index.ts    the only public surface of each of the 17 subpaths
│   │   ├── src/internal/             shared, private: runtime (PlatformRuntime), events, instruments (the Tier 1 port),
│   │   │                             batcher, unload (keepalive budget, LLD §7.5), environments, online, redirect,
│   │   │                             reload (onBeforeReload / reloadPage), retry-after (/http and /auth), flag-provider (/flags and /auth), locale,
│   │   │                             session, ids, urls (stripUrlQueries), generated/ (contracts as TS: never edit)
│   │   ├── src/root.ts               "." entry: throws (import a subpath)
│   │   ├── contracts/                generated from pinned backend commits (sources.json): never edit
│   │   ├── api/<subpath>.api.md      api-extractor reports: the SemVer surface
│   │   ├── subpaths.json             subpaths, layers, areas, allowed imports (single source)
│   │   └── tsup.config.ts            one entry per subpath; build heap 4 GB (package.json "build")
│   ├── webpack-preset/               shared.ts (bundler-neutral), index.ts (webpack), rspack.ts, rsbuild.ts, rspack-preset.ts (Rspack passed in);
│   │                                 platformShared, sharedFor, platformWebpackConfig, ProvideSdkPlugin,
│   │                                 SdkVersionPlugin (src/sdk-version.ts), ChunkIntegrityPlugin (src/integrity.ts:
│   │                                 JS and CSS); src/generated/sdk.ts generated; README.md (in the tarball)
│   └── eslint-plugin/                src/rules.ts; src/generated/{sdk,forbidden-headers}.ts generated; README.md
├── examples/
│   ├── shell/                        reference shell: bootstrap.tsx (the design doc's order), session-context.ts (P-35 retry),
│   │                                 ShellRoot.tsx, environment.mjs, IAM ports, session screens
│   ├── remote-tenders/               reference remote (exposes ./EditTender)
│   ├── cloudfront/                   behaviors, response-headers policy (csp.mjs), SPA rewrite (static extensions only), /csp-report Lambda
│   └── collector/                    reference OTel Collector: gateway.yaml + aggregator.yaml, README (Mimir series limits) (+ test/: allowlists = registry)
├── test/
│   ├── unit/<subpath>/ · unit/sdk · unit/webpack-preset · unit/eslint-plugin · unit/internal
│   ├── integration/                  subpaths wired together in-process
│   ├── e2e/                          the reference shell + remote end to end (jsdom, Keycloak fake)
│   ├── smoke/                        served builds (or a deployed shell: SMOKE_BASE_URL)
│   ├── browser/                      Playwright × 3 engines, production CSP; harness/, styled-remote/ (CSS SRI), engine-notes.ts
│   ├── collector/                    the reference Collector in its image (2 gateways + 2 aggregators)
│   ├── stack/                        Playwright against docker-compose.yml (Keycloak, Envoy, IAM, floci, Collectors);
│   │                                 scripts/ (prepare.mjs: content-hashed remote deploy version, deploy-web.sh)
│   ├── fixtures/ · testenv/
├── docker/ + docker-compose.yml      the integrated stack (edge shim, envoy, floci, go-probe, otel, org-membership seed)
├── monitoring/                       Tier 1 proposal (registry/), Grafana dashboard, Prometheus rules (all proposed)
├── scripts/                          sync-contracts, sync-exports, sync-docs, api-report, metrics-parity, metrics-proposal,
│                                     check-examples, check-publish; pure logic in scripts/lib (unit-tested)
├── docs/                             design/, architecture/ (+ mermaid/*.mmd), lld/, areas/, observability/,
│                                     problem-details/, e2e/ (the integrated-deployment report)
├── .github/                          workflows (ci, release, validate-*, changelog-check, stack-nightly), scripts/
│                                     (eslint-9.sh, react-floor.sh, coverage-gate.sh, …), actions/setup, dependabot.yml
└── .changeset/                       pending changesets; pre.json + pre/ (consumed, changesets v3 pre mode)
```

## SDK Layers

`subpaths.json` assigns each subpath a layer; a subpath may import only lower layers (and only those it lists). Enforced by `test/unit/sdk/dependency-rules.test.ts` and `pnpm depcruise`.

| Layer | Subpaths | Area |
|---|---|---|
| 0 | `/core`, `/problem`, `/authz` | Foundation; identity & access |
| 1 | `/config`, `/security`, `/storage` | Foundation; UI support; identity & access |
| 2 | `/tracing`, `/logging`, `/metrics` | Observability |
| 3 | `/http`, `/flags`, `/i18n` | Data access; MFE platform; UI support |
| 4 | `/auth`, `/mfe`, `/nav` | Identity & access; MFE platform |
| 5 | `/react`, `/testing` | Developer surface |

Cross-layer needs that would point upwards go through `src/internal`: the instrument port (`/http`, `/mfe` record Tier 1 metrics without importing `/metrics`), the event bus (`/react` follows state), the unload coordinator (`/tracing`, `/logging`, `/metrics` share one budget).

## The Runtime

One `PlatformRuntime` per page on `globalThis[Symbol.for('@bcbp-solutions-fzc-llc/frontend-sdk')]`, shared by every SDK copy of a compatible version: the same major, or for a pre-release the same version (`1.0.0-alpha.3` and `alpha.4` each keep their own). An incompatible copy keeps its own runtime; any second copy logs one error. It holds identity, consent, config, the telemetry providers, the identity provider and token source, the manifest, flags, i18n, the authorizer, the event topics, the remote container cache, the flag subscription, the before-reload listeners and `unload` (senders, keepalive ledger, reservations, metrics share). Inventory: LLD §6.1. `resetRuntimeForTests()` is for tests only.

## Telemetry Delivery on Hide and Close

`src/internal/unload.ts`: one `pagehide` and one `visibilitychange` listener run the senders in priority order: metrics `-1` (reserves its share, sends after collecting), logs `0` (one `sendBeacon`), spans `1` (newest that fit). Each gets `keepaliveLeft()`; spending is recorded for 5 s, so `pagehide` after a hide gets only what is left of the 60 KiB. Requests start inside the listener. LLD §7.5.

## Build Tooling

- **`platformWebpackConfig({ role, name?, exposes?, mode })`**: shell `publicPath: '/'` (scripts under `/assets`), remote `'auto'`; Trusted Types policy `platform-webpack`; no `eval` devtools; content hashes; `crossOriginLoading: 'anonymous'`.
- **`platformShared` / `sharedFor('shell' | 'remote')`**: React, react-dom, `@opentelemetry/api` and every SDK subpath (except `/testing`) as strict singletons; the shell shares the SDK under `^1.0.0-0`, a remote requires `^<the version it was built against>`.
- **`ProvideSdkPlugin`** (shell): provides every SDK subpath lazily, not only those the shell imports (report Issue 2).
- **`SdkVersionPlugin`** (every preset): fails the build when the SDK installed for the app is not the preset's own version (an app without the SDK is not checked).
- **`containerName(name)`**: a remote's container global is `__platform_mfe_<name>` (`-` as `_`), never the bare name (element ids are `window` properties).
- **`ChunkIntegrityPlugin`** (production): a sha384 for every lazily loaded JS and CSS chunk (CSS through mini-css-extract-plugin, `CssExtractRspackPlugin` or native CSS; any other lazy CSS loader fails the build), fail-closed `MISSING_INTEGRITY`; the HTML's `<script>`s and `<link rel="stylesheet">`s pinned with `integrity` + `crossorigin`.

## Examples

`examples/shell` is the reference integration: bootstrap order (Trusted Types → core → runtime config → consent → tracing, logging, metrics → error handlers → flags → auth → session context → i18n → manifest → render), the IAM ports (PUB-1 workspace resolve, P-35 session context, retried in the background after a transient failure), `ShellRoot` (the provider with the live locale and context), `environment.mjs` (a production build needs `PLATFORM_ENVIRONMENT`), and the session screens (signed out, device clock, session ended, wrong workspace). `examples:check` asserts CSP and sharing on its build.
