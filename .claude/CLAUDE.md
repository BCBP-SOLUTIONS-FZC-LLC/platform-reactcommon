# CLAUDE.md

This file provides guidance to Claude Code when working with **platform-reactcommon**, the shared frontend SDK for the Tender Management SaaS platform's React micro-frontends. It is the browser-side counterpart of the Go `platform-gincommon`. Detailed reference lives in the sibling files listed under [See Also](#see-also). This file is what must always be in context.

## What This Repo Is

A **pnpm monorepo** of three npm packages released together under one version (changesets `fixed`):

| Package | What it is |
|---|---|
| `@bcbp-solutions-fzc-llc/frontend-sdk` | 17 subpaths (`/core`, `/config`, `/problem`, `/tracing`, `/logging`, `/metrics`, `/http`, `/auth`, `/authz`, `/storage`, `/mfe`, `/flags`, `/nav`, `/i18n`, `/security`, `/react`, `/testing`); the root import throws (no barrel) |
| `@bcbp-solutions-fzc-llc/webpack-preset` | Module Federation config for webpack 5, and Rspack / Rsbuild via `/rspack`, `/rsbuild` (v1 protocol, interoperable): shared singletons, `ProvideSdkPlugin`, `ChunkIntegrityPlugin` (sha384 on every lazy chunk and the HTML's scripts) |
| `@bcbp-solutions-fzc-llc/eslint-plugin` | Seven rules (`no-identity-headers`, `no-raw-storage`, `no-unsafe-html`, …) and `configs.recommended` |

Node ≥ 22 (`.nvmrc` 22), pnpm 12 (corepack), TypeScript 6, ESM only, **React 19 only** (`^19.0.0`, floor tested in CI). Published to **GitHub Packages** (`@bcbp-solutions-fzc-llc` scope, `read:packages` to install). The repository is **private** on GitHub Team. Nothing here is deployed: `examples/` holds a reference shell, a remote, CloudFront snippets and the reference OTel Collector configuration.

**Status:** **`1.0.0-alpha.1` released 2026-11-03** (tag `v1.0.0-alpha.1`, GitHub pre-release, packages under dist-tag `alpha`). The repo is in changesets pre mode (`alpha`) until the first end-to-end environment, when `1.0.0` is cut. New work goes under `[Unreleased]` in `CHANGELOG.md` with a `.changeset/*.md`. Open items: [LLD §15](../docs/lld/platform-reactcommon-lld.md#15-open-items) (Tier 1 `platform_web_*` metrics await governance ratification; gateway Issues 3, 9, 14 are with Platform).

**Key responsibilities (the SDK is the sole browser implementation of):**
- **Page identity and correlation:** `initializeCore` (domain / service / environment from the registry), session id, request id, W3C trace context to the page origin and an exact allowlist only.
- **Sign-in (IAM's browser side):** Keycloak Authorization Code + PKCE S256, tokens **in memory only**, single-flight refresh, silent restore, cross-tab sign-out over `BroadcastChannel('platform-auth')`. Sign-out is **global by default** (ends the Keycloak session; `{ global: false }` opts out).
- **API calls:** `createApiClient`: route templates, identity headers refused, the token on the page origin only, retries for idempotent calls, RFC 9457 problems.
- **Telemetry:** OTLP/HTTP to same-origin `/otel` (traces, logs, Tier 2/3 metrics), redacted and consent-gated; one keepalive budget for hide and `pagehide` (`src/internal/unload`).
- **Micro-frontends:** the remote manifest with SRI, `loadRemote`, kill switches, chunk-error reload, app-update polling.

**Does NOT own:** authentication itself (Keycloak + the gateway), authorization policy (AuthZ Enrichment; `/authz` gives UI hints only), the Collector / Tempo / Loki / Mimir deployments, the metric registry's content (platform-gincommon + observability governance), the shell's and remotes' deployment.

## Common Commands

```bash
pnpm run setup        # install + git hooks (once per clone)
pnpm verify           # exports, docs, lint, typecheck, tests, build, examples, API reports, depcruise
pnpm test             # Vitest: unit, integration, e2e (+ examples', scripts' tests)
pnpm test:coverage    # with coverage of packages/*/src (gate 98% statements; 98.8% today, 1295 tests)
pnpm lint / typecheck / build
pnpm api / api:check  # api-extractor reports (packages/frontend-sdk/api/*.api.md)
pnpm exports:sync / docs:sync / contracts:sync    # generated files; *:check in CI
pnpm run test-browser             # Playwright, Chromium + Firefox + WebKit, production CSP
pnpm run test-collector           # the reference Collector in its image (Docker)
pnpm run stack-up && pnpm run test-stack && pnpm run stack-down   # the integrated stack (Docker, ~16 min)
pnpm changeset                    # record a change to a published package
pnpm run version-packages         # release PR only
```

Run one test: `pnpm exec vitest run test/unit/auth/oidc.test.ts -t "logout"`. Full command list: [`operations.md`](operations.md).

## Architecture

Six layers inside the SDK (`subpaths.json` is the single source; `test/unit/sdk/dependency-rules.test.ts` and dependency-cruiser enforce it): foundation (`/core`, `/problem`, `/authz`) → `/config`, `/security`, `/storage` → telemetry → `/http`, `/flags`, `/i18n` → `/auth`, `/mfe`, `/nav` → `/react`, `/testing`. Shared page state lives in one `PlatformRuntime` on `globalThis[Symbol.for('@bcbp-solutions-fzc-llc/frontend-sdk')]`. Layout: **[`architecture.md`](architecture.md)**; flows: **[`request-flows.md`](request-flows.md)**; the narrative with diagrams is [`ARCHITECTURE.md`](../ARCHITECTURE.md); the contract is the [LLD](../docs/lld/platform-reactcommon-lld.md); decisions are in [`docs/design/frontend-sdk-design.md`](../docs/design/frontend-sdk-design.md).

## Critical Rules (do not break)

- **No token ever leaves memory.** Not to `localStorage`, `sessionStorage`, the `BroadcastChannel`, logs or spans. `test/unit/auth/oidc.test.ts` asserts it; keep it asserted.
- **The browser never sends identity headers** (`x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`: `FORBIDDEN_REQUEST_HEADERS`, generated from AuthZ Enrichment). The gateway injects them.
- **gincommon is the behavioural source of truth** for the registry, log field names, redaction, problem types and header names. Backend-shaped data is **generated** into `packages/frontend-sdk/contracts/` and `src/internal/generated/` from pinned commits (`contracts/sources.json`): never edit generated files; run `pnpm contracts:sync`. Move a pin by editing its sha (or `--update-pins`, then review every moved pin).
- **CSP-safe always:** no `eval`, `new Function` or runtime CSS-in-JS; Trusted Types policies `platform-sdk` / `platform-webpack`. `zod/mini` in jitless mode.
- **Unload requests start inside the listener.** Anything sent on `pagehide` is `sendBeacon` / fetch `keepalive` started synchronously, within the shared budget (`onUnload`, LLD §7.5). Never `await` before it.
- **Public API changes** show in `packages/frontend-sdk/api/*.api.md` (`pnpm api`): each needs a changeset and a CHANGELOG entry; a breaking one is a **major** changeset (`1.0.0-alpha.N` bumps `N`) and a `### Changed` "**Breaking:**" entry with the opt-out.
- **Diagrams:** edit `docs/architecture/mermaid/*.mmd`, then `pnpm docs:sync` (ARCHITECTURE.md's blocks must equal their sources). Render-check with `ghcr.io/mermaid-js/mermaid-cli/mermaid-cli:11.4.2`.
- **Required checks** keep their names: `Validate / Test / test`, `Validate / Quality / quality`, `Validate / Contracts / contracts`, `changelog`.
- **Sibling repos are read-only** from here (`../../go/*`, `../../python/*`, `../../../XPertPMS/IAM/*`): build and read them, never modify; use scratch clones to check pinned commits.

## Conventions

- One public surface per subpath: `src/<subpath>/index.ts`. `src/internal/` is shared but private (`events`, `runtime`, `unload`, `environments`, `generated/` …).
- Tests mirror `src/`: `test/unit/<subpath>/`; `test/integration` (subpaths wired in-process); `test/e2e` (the reference shell end to end, jsdom); `test/browser` (Playwright); `test/collector`, `test/stack` (Docker). A regression test names the issue it covers (report Issue N, known browser bug N).
- Timing in tests: CI runs on 2-core private-repo runners. Wait on conditions with real-time bounds, never on a fixed number of fake-clock turns; document engine limits in `test/browser/engine-notes.ts` and skip only on them.
- Docs written in plain, direct English; tables over long prose; every claim checkable against the code.
- Commits: Conventional Commits; PRs into `main` (squash merges). Don't stack PRs on each other's branches without retargeting each to `main` before merging.

## See Also

| File | Contents |
|---|---|
| [`architecture.md`](architecture.md) | Repository and package layout, layers, the runtime, build tooling, examples |
| [`request-flows.md`](request-flows.md) | Shell bootstrap, sign-in, refresh, sign-out, API call, remote load, telemetry on hide/close |
| [`api-reference.md`](api-reference.md) | Every subpath's exports (generated from the API reports) and the tooling packages |
| [`wire-contracts.md`](wire-contracts.md) | Headers, storage keys, channel, OTLP paths, problem types, metric names, Collector |
| [`operations.md`](operations.md) | Commands, CI, release, nightly, the stack, runners and secrets; the Claude Code settings and hooks |

**Skills:** `/release <version>` (user-only: the release PR, the tag steps, watching the publish) · `/ci-triage <run or job URL>` (fetch a failed run's logs and artifacts, match [`skills/ci-triage/known-causes.md`](skills/ci-triage/known-causes.md), reproduce, fix).
**Subagents** (read-only; pass them a diff file): `invariant-reviewer` (tokens, identity headers, origins, CSP, unload, sign-out, redaction, generated files, layers) before a PR touching the SDK, the preset or the examples; `api-change-reviewer` (API report, changeset bump, CHANGELOG, docs) before a PR that changes the public surface or a default.
