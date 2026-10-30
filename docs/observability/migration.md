# Moving an existing app onto the SDK

gincommon's migration page maps removed metric names to their standard replacements. The SDK has no legacy names: it started on the standard, and no frontend has been deployed. This page maps the patterns an existing React app usually has to what replaces them, and to the lint rule or check that catches what's left over. `@platform/eslint-plugin`'s `configs.recommended` turns on every rule below.

## Pattern mapping

| Before | After | Caught by |
|---|---|---|
| `fetch('/api/tenders/' + id)`, axios | `useApi((c, signal) => c.get('/tenders/:id', { params: { id }, signal }))`, or `useApiClient()` | `@platform/api-route-template` (built URLs) |
| Setting `x-tenant-id` / `x-user-id` in a request | Nothing: the gateway derives identity from the token | `@platform/no-identity-headers`; `/http` drops them |
| Reading `response.json().message` on errors | `isProblemError(e)` → `e.is(PlatformProblemTypes.X)`, `toFieldErrorMap(e)`, `problemMessage(e)` | — |
| `console.log` / `console.error` | `getLogger({ mfe }).info/warn/error(msg, attrs)` (correlated, redacted, consent-gated) | — |
| Ad-hoc timing + a metrics SDK | Tier 3 `getServiceMeter({ mfe })` (names `<domain>_<service>_*`); HTTP and remote-load timing are recorded by the SDK | `InvalidMetricError` at registration; `metricslint check` on `renderMetricInventory()` in CI |
| `localStorage.setItem('token', …)` | Nothing: tokens stay in the SDK's memory | `@platform/no-raw-storage`; `ForbiddenStorageKeyError` |
| `localStorage` for app data | `storage(appId).set(key, value)` (namespaced by workspace, cleared on logout) | `@platform/no-raw-storage` |
| `el.innerHTML = html`, `dangerouslySetInnerHTML={{ __html: html }}` | `sanitizeHtml(html)` from `/security` | `@platform/no-unsafe-html` |
| `styled-components`, Emotion, MUI | Zero-runtime CSS (CSS Modules, vanilla-extract, Linaria) | `@platform/no-runtime-css-in-js` |
| `window.location.href = returnUrl` | `navigate(appId, path)`; `isSafeRedirect(url)` for any redirect target | — |
| An app-owned OIDC library, tokens in storage | `/auth` (`createOidcProvider`, shell only); remotes read `useSession`, `useCurrentUser` | — |
| Hard-coded role checks | `useHasPermission(action, resource)`, `<Can>` (role map set by the shell from P-35) | — |
| `import x from '@platform/frontend-sdk'`, deep imports | Subpath imports (`@platform/frontend-sdk/http`) | `@platform/no-sdk-root-import`, `no-sdk-deep-import` |
| Its own webpack Module Federation config | `platformWebpackConfig({ role: 'remote', name, exposes, mode })` | `pnpm examples:check`-style checks in the app's CI |
| `eval`, `new Function`, inline scripts | Not allowed (CSP `script-src 'self'`) | `no-eval`, `no-implied-eval`, `no-new-func` |

## Upgrading a remote

1. Add `@platform/frontend-sdk` as a dependency and build with `@platform/webpack-preset`. The SDK is then shared from the shell (`import: false`), never bundled.
2. Add `@platform/eslint-plugin` with `configs.recommended`, and fix what it reports.
3. Wrap the exposed module's root in `<MFEErrorBoundary mfe="<name>">`, or rely on the shell's `RemoteBoundary`.
4. Replace data fetching with `useApi` / `useApiClient` and route templates. Register each page's template with `useRouteTemplate('/tenders/:id/edit')`.
5. Replace error handling with the problem helpers. Map field errors with `toFieldErrorMap`.
6. Move UI text into a namespace (`registerNamespace('<name>', loader)`) and read it with `useT('<name>')`.
7. Save drafts from `useBeforeAuthRedirect(() => storage('<name>', { area: 'session' }).set('draft:<form>', value))`.
8. In unit tests, use `createTestPlatform()`, `mockApi()` and `mockProblem()`. In CI, run `metricslint check` on `renderMetricInventory()`.

## Upgrading the shell

Follow the bootstrap in design doc §C2 / `examples/shell/src/bootstrap.tsx`:
1. Identity `portal` / `web-app` from build constants.
2. `runtime.json` per environment (`examples/shell/public/config/runtime.json`).
3. The consent manager before telemetry.
4. The PUB-1 and P-35 ports, tested against `contracts/tenant-resolve-cases.json` and `session-context-cases.json`.
5. Your own signed-out, session-ended and wrong-workspace screens.
6. The CloudFront response headers of `examples/cloudfront`.

## Queries before → after

```text
# before: per-app ad-hoc names
sum(rate(tenders_api_errors[5m]))

# after (once Tier 1 is ratified): one metric for every remote, split by mfe and route template
sum by (mfe, route) (rate(platform_web_http_client_duration_seconds_count{error_class!="success"}[5m]))
```
