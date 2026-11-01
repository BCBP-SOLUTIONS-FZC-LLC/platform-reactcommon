# Browser tests

The SDK in real engines (Chromium, Firefox and WebKit, through Playwright), served with the
**production response headers** (`examples/cloudfront/csp.mjs`: `script-src 'self'`,
`require-trusted-types-for 'script'`, …). They cover what jsdom and happy-dom cannot model, which is
where earlier bugs came from:

| Spec | What it checks |
|---|---|
| `keepalive.spec.ts` | The 64 KiB keepalive budget on tab close: the newest spans that fit go in one keepalive request; queued logs go by beacon. A tab switch delivers every queued span and log with no export failure. |
| `events.spec.ts` | The order of `beforeunload`, `pagehide` and `visibilitychange` on close and on navigation in each engine. The SDK delivers in either order, and with `pagehide` alone. |
| `http.spec.ts` | `/http` deadlines and aborts (before the response and while reading the body), with and without `AbortSignal.any` (Safari < 17.4), under GC pressure. Also checks that a long-lived caller signal does not keep growing its listener list. |
| `platform-apis.spec.ts` | Trusted Types (`sanitizeHtml` returns TrustedHTML where the engine has it), `BroadcastChannel` and `storage` events across tabs, `crypto.subtle` SHA-256. |
| `integrity.spec.ts` | The real tenders remote (built in production by global setup), loaded as the shell does under the production CSP: every chunk its webpack runtime injects carries its sha384, and a chunk altered in transit is refused, its code never run. |
| `navigation.spec.ts` | A leaving page sees its in-flight request rejected, always after `beforeunload` (the signal `/auth` uses not to restore while navigating away). |
| `csp.spec.ts` | Booting core, config, tracing, logging, metrics, http and security under the production CSP causes no violation and no `eval`/`new Function`. Two controls show that each engine's violation detectors work. |

Every test also fails on any CSP violation, page error or console error in its pages (the `guard`
fixture in `fixtures.ts`). The run fails if any report reaches `/csp-report`.

## Running

```sh
pnpm install
pnpm run test-browser-install          # once: Playwright's Chromium, Firefox and WebKit builds
pnpm run test-browser                  # all three engines (about 30 s)
pnpm run test-browser --project=webkit # one engine (chromium, firefox or webkit)
pnpm run test-browser csp              # one spec file
```

On Linux CI, install the browsers' system libraries too: `pnpm exec playwright install --with-deps chromium firefox webkit`.
Locally there are no retries. In CI (`CI` set) there is one retry, and an HTML report is written to `playwright-report/`.

`openssl` must be on the `PATH`. It generates the server's throwaway certificate.

The suite is not part of `pnpm test`: Vitest runs only `test/{unit,integration,e2e}`.

## How it works

- **`harness/entry.ts`** imports the SDK from source (`packages/frontend-sdk/src/<subpath>/index.ts`)
  and exposes `window.harness`, which the specs drive with `page.evaluate`. `global-setup.ts` bundles it
  with esbuild into `.build/harness.js` (one IIFE, es2022, no eval). `harness/index.html` loads it with
  `<script src>`; the page has no inline script.
- **`server.ts`** serves the page with the production headers, `/config/runtime.json`, and OTLP
  collectors at `/otel/v1/{traces,logs,metrics}` that record every request (arrival order, size,
  content type, decoded JSON, and `via`: `beacon`, `keepalive` or `fetch`). It also serves `/api/*`
  test endpoints (slow, hanging, slow body, problem+json, echo headers) and `/csp-report`. Each test
  is a "run": the page URL carries `?run=<id>`, and the harness tags what the page sends with it.
  Tests read their own run at `GET /__collected?run=<id>`, so tests can run in parallel.
- **HTTPS**: the server uses node:https with a self-signed certificate for 127.0.0.1, and the
  browsers ignore certificate errors. The production CSP includes `upgrade-insecure-requests`, and
  WebKit upgrades even `http://127.0.0.1` subresources under it. Over plain HTTP the page could not
  load its own script without weakening the policy.
- **CSP and `page.evaluate`**: none of the three engines applies the page's CSP to code generation
  started from the automation protocol. `new Function` succeeds there even under
  `script-src 'self'`. So the harness runs everything the CSP governs (boot, `sanitizeHtml`, the
  controls) in a page task.
- **Tab switch**: headless engines never hide a page. Bringing another page to the front does not
  hide this one. `harness.setVisibility()` emulates a switch: it sets `document.visibilityState` and
  dispatches `visibilitychange`.

## Lifecycle events

These are the events seen in Playwright's headless engines. The harness records them in the page
and sends each one with a beacon as it fires.

| Engine | Close (`page.close({ runBeforeUnload: true })`) | Navigation |
|---|---|---|
| Chromium | `beforeunload` → `pagehide`, then sometimes `visibilitychange(hidden)` | `beforeunload` → `pagehide`, then sometimes `visibilitychange(hidden)` |
| Firefox | `beforeunload` → `pagehide` → `visibilitychange(hidden)` | `beforeunload` → `pagehide` → `visibilitychange(hidden)` |
| WebKit | `beforeunload` → `pagehide` → `visibilitychange(hidden)` | `beforeunload` → `pagehide` → `visibilitychange(hidden)` |

No engine fires `visibilitychange(hidden)` before `pagehide`. This contradicts a comment in
`tracing/processor.ts`, but nothing breaks: `pagehide` sends the newest spans that fit, and the later
`flushOnHidden` finds the queue empty. No engine reported `freeze`, and `pagehide.persisted` was
always `false` (no back/forward cache).

## Known SDK bugs

Each bug has a failing test kept as `test.fail`, with the note from `known-bugs.ts`. When a bug is
fixed, its test reports "expected to fail" but passes. Remove the `test.fail` line and the note.

1. **Shared keepalive budget** (`SHARED_BUDGET`; Chromium, WebKit). The span keepalive request
   (≤ 60 KiB) and the log beacons (≤ 60 KiB) are budgeted separately. The browser's 64 KiB budget is
   per page and shared by both. On close, Chromium and WebKit refuse the log beacon, and the logs go
   by plain fetch, which a closing tab cancels. On a tab switch, WebKit logs "Reached maximum amount
   of queued data of 64Kb", then retries the span request.
2. **Unload request started after an await** (`UNLOAD_LOSS`; seen in Firefox, rarely in Chromium).
   The OTLP fetch transport awaits `headers()` before it calls `fetch()`, so the span request on
   `pagehide` starts a microtask after the listener. A closing tab is sometimes torn down first, and
   no span request is sent: about 1 close in 5 in Firefox. The close tests skip with this note when
   that happens. "unload: the SDK starts its span and log requests within the pagehide listener"
   pins the cause in every engine.
3. **sanitizeHtml makes Chromium report violations** (`SANITIZE_REPORTS`; Chromium). DOMPurify
   parses the input with `DOMParser`. In Chromium the parsed document inherits the page's CSP, so
   each inline handler or `style` attribute in the input is reported to `/csp-report`, even though
   the output is clean.
4. **AbortSignal.any in WebKit** (`WEBKIT_ABORT_ANY`; WebKit ≥ 17.4). When the page collects
   garbage, the native `AbortSignal.any` loses the abort. The caller's abort never reaches `fetch`,
   and neither does the client deadline when the caller passes a signal: the call hangs or
   completes. The SDK's own fallback for engines without `AbortSignal.any` is not affected.

## Skips

- The `storage` event part of the cross-tab test, in WebKit. Playwright's WebKit dispatches no
  `storage` event between pages of one context, even for a plain `localStorage.setItem` (Safari
  does). The value itself is checked in all three engines.
- Close tests, at run time, when no span request came at all (bug 2).
