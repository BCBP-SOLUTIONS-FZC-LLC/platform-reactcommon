// Engine behaviour the suite works around (not SDK bugs).

/**
 * A closing tab sometimes never sends the requests its pagehide listener started. The SDK starts its
 * unload requests synchronously inside the listener (sendBeacon, else fetch keepalive; pinned by
 * keepalive.spec.ts "unload: the SDK starts its span and log requests within the pagehide listener"),
 * yet Playwright's Firefox loses about 1 close in 3 and Chromium and WebKit about 1 in 30, with either
 * transport (measured 2026-11-01, 30 closes each). Tests that assert delivery after a close skip with
 * this note when nothing arrived; tests that assert what was sent keep running.
 */
export const CLOSE_LOSS =
  'engine: the closing tab was torn down before it sent the requests its pagehide listener started (the SDK starts them synchronously; see engine-notes.ts)';

/**
 * Metrics are collected asynchronously (the OpenTelemetry metrics SDK has no synchronous collect), so on
 * a pagehide with no hidden phase before it their beacon starts after the listener returns. Playwright's
 * close fires pagehide without visibilitychange; a closing Chromium tab then drops that later beacon when
 * the listener also sent large log and span beacons (1 delivery in 15, measured 2026-11-03; 14 in 15 with
 * metrics alone). Real browsers fire visibilitychange (hidden) before pagehide when a tab closes, and
 * the interval is sent then, while the page is alive: keepalive.spec.ts "a close as browsers do it"
 * asserts that path without a skip.
 */
export const METRICS_AFTER_PAGEHIDE =
  'engine: a close with no hidden phase first (Playwright) sends the metrics interval after the pagehide listener, and the closing tab may drop it; see engine-notes.ts';
