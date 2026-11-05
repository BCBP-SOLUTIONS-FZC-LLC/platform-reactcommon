# Architecture diagrams

Standalone Mermaid source files. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) embeds every one of these `.mmd` files verbatim as a fenced code block, each under a `> Source:` link back to the file here, so a diagram only needs to be correct in one place. `pnpm docs:sync` rewrites the embedded blocks from these files; `pnpm docs:check` (CI, *Validate / Quality*) fails when a block differs from its file, or when a `.mmd` is not embedded or not listed below.

| File | Diagram | Related section |
|------|---------|-----------------|
| [`layer-model.mmd`](mermaid/layer-model.mmd) | Consumers → build-time packages → the SDK's six layers → `src/internal` → generated contracts | ARCHITECTURE.md § Layer model |
| [`package-dependencies.mmd`](mermaid/package-dependencies.mmd) | Allowed imports between the 17 subpaths and the restricted third-party packages. **Generated** from `packages/frontend-sdk/subpaths.json` | § Package dependency graph |
| [`runtime-registry.mmd`](mermaid/runtime-registry.mmd) | The `PlatformRuntime` on `globalThis`: which subpath writes and reads each field, the change topics, a second SDK copy | § Runtime registry |
| [`shell-bootstrap.mmd`](mermaid/shell-bootstrap.mmd) | The ten bootstrap steps of design doc §C2 and the session outcomes | § Shell bootstrap |
| [`request-flow.mmd`](mermaid/request-flow.mmd) | One `ApiClient` call: dedupe, headers by origin, token, 401 refresh, retries, problem parsing, span and metric | § Request flow |
| [`auth-login-callback.mmd`](mermaid/auth-login-callback.mmd) | Login redirect (PKCE), the pending-login record, callback checks, token exchange, ID-token checks | § Authentication: login and callback |
| [`auth-refresh-restore.mmd`](mermaid/auth-refresh-restore.mmd) | Session states: silent restore, single-flight refresh, ambiguous failure, expiry kinds, cross-tab events | § Session lifecycle |
| [`remote-loading.mmd`](mermaid/remote-loading.mmd) | Manifest validation, kill switch, script injection (SRI, Trusted Types), share scope, retries, boundary, chunk reload, version polling | § Remote loading |
| [`error-handling.mmd`](mermaid/error-handling.mmd) | Response → `ProblemError` / synthetic problem → gateway deny codes → UI and error boundaries | § Error handling (RFC 9457) |
| [`workspace-resolution.mmd`](mermaid/workspace-resolution.mmd) | `chooseWorkspace` before sign-in: URL slug, workspace cache, PUB-1, the realm-fits check, the identifier-first screen | § Workspace resolution before sign-in (PUB-1) |
| [`integration-touchpoints.mmd`](mermaid/integration-touchpoints.mmd) | Every call the SDK makes outside the page, its bound and what a failure does | § Integration touchpoints |
| [`cache-strategy.mmd`](mermaid/cache-strategy.mmd) | Memory, localStorage, sessionStorage and HTTP caches with their bounds | § Cache strategy |
| [`data-model.mmd`](mermaid/data-model.mmd) | `runtime.json`, the `PlatformRuntime`, the manifest, storage keys, the workspace cache, memory-only tokens | § Data model |
| [`cross-tab-events.mmd`](mermaid/cross-tab-events.mmd) | `BroadcastChannel('platform-auth')` logout and workspace switch, shared localStorage marks, runtime topics → React hooks | § Cross-tab and in-page events |
| [`telemetry-pipeline.mmd`](mermaid/telemetry-pipeline.mmd) | Logs, spans and metrics → redaction, sampling, registration checks → consent → bounded queues → `/otel` | § Telemetry pipeline |
| [`workspace-isolation.mmd`](mermaid/workspace-isolation.mmd) | Storage namespaces per workspace and everything that clears them | § Workspace isolation in the browser |
| [`contracts-drift.mmd`](mermaid/contracts-drift.mmd) | Pinned backend commits → `sync-contracts` → generated files → CI drift gates | § Contracts and drift control |
| [`ci-pipeline.mmd`](mermaid/ci-pipeline.mmd) | `ci.yml` job graph, `release.yml` (verify → gates → GitHub Release), changelog check | § CI and release |
| [`deployment.mmd`](mermaid/deployment.mmd) | One build per app, S3 objects in deploy order, CloudFront behaviors and headers | § Deployment |
| [`schema-lifecycle.mmd`](mermaid/schema-lifecycle.mmd) | Generated backend contracts vs the browser-facing schemas this repo owns, and how each changes | § Schema lifecycle |
| [`documentation-assets.mmd`](mermaid/documentation-assets.mmd) | Documentation sources, what keeps each in sync, where they are rendered | § Documentation assets |

To render locally, open any `.mmd` file in a Mermaid-aware IDE (VS Code + Mermaid Preview, IntelliJ + Mermaid plugin) or paste it into [mermaid.live](https://mermaid.live).

When you change a diagram, run `pnpm docs:sync` and commit both the `.mmd` file and `ARCHITECTURE.md`. A new diagram needs a `> Source:` line plus an empty ```` ```mermaid ```` block in `ARCHITECTURE.md` and a row here; `docs:sync` fills the block.
