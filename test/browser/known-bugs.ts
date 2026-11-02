// SDK bugs this suite found, each kept as a failing test (test.fail) with this note, and listed in
// README.md "Known SDK bugs". When one is fixed, its test.fail starts failing ("expected to fail"):
// remove the annotation and this note.

/**
 * SDK bug 2: a closing tab sometimes never issues the unload request for spans (seen in about 1 close
 * in 5 in Firefox, rarely in Chromium). The close tests skip with this note when it happens, and
 * "unload: the SDK starts its span and log requests within the pagehide listener" pins the cause.
 */
export const UNLOAD_LOSS =
  'SDK bug: the span request on unload is started after an await inside the OTLP exporter (fetch-transport.ts awaits headers() before fetch()), ' +
  'a microtask after the pagehide listener; a closing tab may be torn down before that microtask runs (Firefox often, Chromium rarely), ' +
  'and then no span request is sent at all.';

/** SDK bug 1: spans and logs each budget 60 KiB of one shared 64 KiB. */
export const SHARED_BUDGET =
  'SDK bug: the span keepalive request (≤ 60 KiB) and the log beacons (≤ 60 KiB each) are budgeted separately, but the browser\'s 64 KiB ' +
  'keepalive budget is per page and shared by fetch keepalive and sendBeacon; Chromium and WebKit refuse the log beacon once the spans took ' +
  'the budget, and the records go by plain fetch, which a closing tab cancels.';

/**
 * SDK bug 3: sanitizeHtml makes Chromium report CSP violations for the hostile input it removes.
 * DOMPurify parses the input with DOMParser, whose document inherits the page's CSP in Chromium, so
 * each inline handler (onclick, onerror, …) or style attribute in the INPUT is reported
 * (script-src-attr / style-src-attr 'inline') and POSTed to /csp-report, though the output is clean
 * and nothing runs. Any user-supplied rich text can then fill the CSP report stream with noise
 * (security/index.ts says a sanitised fragment "cannot trigger reports"). Gecko and WebKit report nothing.
 */
export const SANITIZE_REPORTS =
  'SDK bug: sanitizeHtml parses hostile input with DOMParser, which inherits the page CSP in Chromium: every inline handler or style ' +
  'attribute in the input is reported as a script-src-attr / style-src-attr violation (and POSTed to /csp-report), though the output is clean.';

/**
 * SDK bug 4: in WebKit (Safari ≥ 17.4), the native AbortSignal.any loses the abort while the page
 * collects garbage, so a caller's abort, and the client deadline when a caller signal is passed, never
 * reach fetch: the call runs to the server's answer, or hangs. Seen in 11 of 12 calls under allocation
 * pressure (and about 1 in 8 without), never in Chromium or Gecko. http/client.ts anySignal prefers the
 * native API; its own fallback (listeners on both signals) is not affected.
 */
export const WEBKIT_ABORT_ANY =
  "SDK bug: http/client.ts uses the native AbortSignal.any where it exists; WebKit's loses the source signal's abort under GC, so " +
  'the caller abort and the deadline next to a caller signal never reach fetch (the call hangs or completes). The by-hand fallback works.';
