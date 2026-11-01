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
