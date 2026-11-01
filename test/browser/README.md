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

## SDK bugs this suite found (all fixed)

Each was kept as a failing test (`test.fail`) until its fix landed; those tests now assert the fixed behaviour.

1. **Shared keepalive budget** (Chromium, WebKit). The span keepalive request and the log beacons were
   budgeted separately (≤ 60 KiB each), but the browser's 64 KiB is per page and shared, so on close
   the second was refused. **Fix:** one `pagehide` listener per page hands out one budget
   (`src/internal/unload.ts`): logs first, since errors and essential warnings are what operations see
   without consent, then the newest spans that fit what is left. `keepalive.spec.ts` "spans and logs"
   asserts every log goes by beacon and both requests fit together.
2. **Unload request started after an await.** The OTLP exporter awaits `headers()` before `fetch()`,
   so the span request started a microtask after the `pagehide` listener. **Fix:** on unload the SDK
   serialises the spans and starts the request itself, inside the listener (`sendBeacon`, else
   `fetch` keepalive). "unload: the SDK starts its span and log requests within the pagehide
   listener" pins it in every engine.
3. **sanitizeHtml made Chromium report violations.** Chromium applies the page CSP while DOMPurify
   parses hostile input; every way of creating the detached document inherits it, so each handler or
   `style` attribute in the input was reported to `/csp-report`. **Fix:** a pre-pass removes those
   attributes and `<style>` elements before parsing (`security/markup.ts`). DOMPurify would remove
   them anyway and remains the security boundary.
4. **AbortSignal.any in WebKit.** The native `AbortSignal.any` lost the abort under GC. **Fix:** the
   SDK always combines the signals by hand, and releases its listeners when the call ends.

## Skips

- The `storage` event part of the cross-tab test, in WebKit. Playwright's WebKit dispatches no
  `storage` event between pages of one context, even for a plain `localStorage.setItem` (Safari
  does). The value itself is checked in all three engines.
- Close tests, at run time, when nothing arrived at all (`CLOSE_LOSS` in `engine-notes.ts`). A
  closing tab sometimes never sends what its `pagehide` listener started, with either transport:
  about 1 close in 3 in Playwright's Firefox and 1 in 30 elsewhere (measured over 30 closes each).
  The SDK starts the requests synchronously; the "starts … within the pagehide listener" test is
  not skipped.
