// The real-browser harness (test/browser/README.md): the SDK from source, booted as the shell boots it
// (design doc §C2), behind a small window.harness API that the Playwright specs drive with
// page.evaluate. No inline script: index.html loads the esbuild bundle of this file with <script src>.
import './instrument.ts';
import { loadRuntimeConfig, setRuntimeConfig } from '../../../packages/frontend-sdk/src/config/index.ts';
import { initializeCore, setConsentProvider } from '../../../packages/frontend-sdk/src/core/index.ts';
import { createApiClient } from '../../../packages/frontend-sdk/src/http/index.ts';
import { getLogger, initializeLogging } from '../../../packages/frontend-sdk/src/logging/index.ts';
import { getServiceMeter, initializeMetrics } from '../../../packages/frontend-sdk/src/metrics/index.ts';
import { installTrustedTypesPolicy, sanitizeHtml } from '../../../packages/frontend-sdk/src/security/index.ts';
import { storage } from '../../../packages/frontend-sdk/src/storage/index.ts';
import { getTracer, initializeTracing } from '../../../packages/frontend-sdk/src/tracing/index.ts';
// Internal counters and the runtime (not exported from the subpaths): what the unit tests read too.
import { getRuntime } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { loggingStats } from '../../../packages/frontend-sdk/src/logging/logging.ts';
import { metricsStats } from '../../../packages/frontend-sdk/src/metrics/metrics.ts';
import { tracingStats } from '../../../packages/frontend-sdk/src/tracing/tracing.ts';
import { events, otelCalls, PAGE_ID, RUN } from './instrument.ts';

export interface BootOptions {
  /** Telemetry consent granted (default true). */
  consent?: boolean;
  /** Overrides runtime.json telemetry.sampleRatio (1 there). */
  sampleRatio?: number;
  /**
   * Stops visibilitychange from reaching the SDK's listeners (they are on document; this stops the
   * event at window, in the capture phase), as on an engine that never fires it on close.
   */
  suppressVisibilityChange?: boolean;
}

export type HttpScenario =
  | 'ok'
  | 'problem'
  | 'timeout'
  | 'abort'
  | 'abort-get'
  | 'abort-body'
  | 'timeout-body'
  | 'timeout-with-signal'
  | 'echo-headers';

export interface HttpOutcome {
  ok: boolean;
  /** The error's name (TimeoutError, AbortedError, ProblemError, …) when it failed. */
  error?: string;
  status?: number;
  data?: unknown;
  ms: number;
}

/** Errors thrown in the page (window error, unhandled rejections), kept for the specs. */
const pageErrors: string[] = [];
addEventListener('error', (e) => pageErrors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => pageErrors.push(String((e as PromiseRejectionEvent).reason)));

const client = () => createApiClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number, c: string) => c.repeat(Math.max(0, n));

async function boot(o: BootOptions = {}) {
  if (o.suppressVisibilityChange) addEventListener('visibilitychange', (e) => e.stopPropagation(), { capture: true });
  // The shell's bootstrap order: Trusted Types policy first, then core → runtime config → consent → telemetry.
  installTrustedTypesPolicy();
  initializeCore({ serviceName: 'browser-harness', domain: 'portal', environment: 'test', buildVersion: '1.0.0' });
  const cfg = await loadRuntimeConfig();
  setRuntimeConfig(cfg);
  const consent = o.consent ?? true;
  setConsentProvider({ has: (c) => c === 'essential' || (consent && c === 'telemetry'), subscribe: () => () => {} });
  const { otlpBaseUrl, sampleRatio, logLevel } = cfg.telemetry;
  initializeTracing({ otlpBaseUrl, sampleRatio: o.sampleRatio ?? sampleRatio, propagationAllowlist: cfg.api.propagationAllowlist });
  initializeLogging({ otlpBaseUrl, level: logLevel });
  initializeMetrics({ otlpBaseUrl });
  return { run: RUN, pageId: PAGE_ID, trustedTypes: typeof (globalThis as { trustedTypes?: unknown }).trustedTypes === 'object' };
}

/**
 * Ends `n` spans named span-<seq>, each carrying `seq` and about `bytes` of attributes (strings are
 * cut at 256 bytes by the SDK, so the size is spread over several attributes).
 */
function spans(n: number, bytes = 1500, from = 0): number {
  const tracer = getTracer('browser-harness');
  const attrs = Math.ceil(bytes / 200);
  for (let i = from; i < from + n; i++) {
    const s = tracer.startSpan(`span-${i}`, { seq: i });
    for (let a = 0; a < attrs; a++) s.setAttribute(`pad.${a}`, pad(200, String.fromCharCode(97 + (a % 26))));
    s.end();
  }
  return n;
}

/** Emits `n` info logs, log-<seq>, each with about `bytes` of attributes. */
function logs(n: number, bytes = 1000, from = 0): number {
  const log = getLogger({ mfe: 'harness' });
  const attrs = Math.ceil(bytes / 200);
  for (let i = from; i < from + n; i++) {
    const a: Record<string, unknown> = { seq: i };
    for (let k = 0; k < attrs; k++) a[`pad_${k}`] = pad(200, 'x');
    log.info(`log-${i}`, a);
  }
  return n;
}

/**
 * A tab switch as the page sees it: document.visibilityState becomes `state` and visibilitychange is
 * dispatched. Headless browsers keep every page visible (bringing another page to the front does not
 * hide this one), so the switch is emulated; the SDK's listeners run exactly as on a real switch.
 */
function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

/**
 * Dispatches a pagehide (as the browser does when the tab goes away) and counts the collector
 * requests the SDK's listeners started before dispatchEvent returned, i.e. within the listeners
 * themselves, without waiting for a microtask: what a closing engine is certain to send.
 */
function requestsStartedInPagehide() {
  const before = { ...otelCalls };
  dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  const during = { traces: (otelCalls.traces ?? 0) - (before.traces ?? 0), logs: (otelCalls.logs ?? 0) - (before.logs ?? 0) };
  return { during };
}

/** Adds `n` to a Tier 3 counter (the platform's own instruments record nothing yet). */
function count(n = 1): void {
  getServiceMeter().counter('portal_browser_harness_clicks_total', 'Harness clicks.', []).add(n);
}

/**
 * Runs `fn` in a task of the page's own event loop. page.evaluate calls arrive from the automation
 * protocol, and none of the three engines applies the page's CSP to code generation started from that
 * stack (new Function succeeds there under script-src 'self'); a page task is what the page itself runs.
 */
function inTask<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => setTimeout(() => Promise.resolve().then(fn).then(resolve, reject), 0));
}

function stats() {
  return { tracing: { ...tracingStats() }, logging: { ...loggingStats() }, metrics: { ...metricsStats() } };
}

async function outcome(p: () => Promise<{ status: number; data: unknown }>): Promise<HttpOutcome> {
  const t0 = performance.now();
  try {
    const r = await p();
    return { ok: true, status: r.status, data: r.data, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const err = e as { name?: string; status?: number };
    return { ok: false, error: err?.name ?? String(e), ...(err?.status ? { status: err.status } : {}), ms: Math.round(performance.now() - t0) };
  }
}

/** Allocates garbage every 20 ms until the returned stop function is called: a busy page's GC. */
function gcPressure(): () => void {
  let sink: unknown[] = [];
  const timer = setInterval(() => {
    sink = [];
    for (let i = 0; i < 100_000; i++) sink.push({ i, s: `x${i}` });
  }, 20);
  return () => {
    clearInterval(timer);
    sink = [];
  };
}

/**
 * One /http call scenario against the server's /api test endpoints; with `gc`, the page allocates
 * heavily while the call is pending, as a busy app does, so the engine collects garbage meanwhile.
 */
async function http(scenario: HttpScenario, o: { gc?: boolean } = {}): Promise<HttpOutcome> {
  const stop = o.gc ? gcPressure() : () => {};
  const t0 = performance.now();
  // A call the client never ends (an abort or deadline lost) reports 'Stuck' after 2.5 s instead of
  // hanging the test; every scenario settles well before that when the client works.
  const cap = new Promise<HttpOutcome>((resolve) => setTimeout(() => resolve({ ok: false, error: 'Stuck', ms: Math.round(performance.now() - t0) }), 2_500));
  try {
    return await Promise.race([httpScenario(scenario), cap]);
  } finally {
    stop();
  }
}

async function httpScenario(scenario: HttpScenario): Promise<HttpOutcome> {
  const api = client();
  const abortAfter = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
  switch (scenario) {
    case 'ok':
      return outcome(() => api.get('/ok', { dedupe: false }));
    case 'echo-headers':
      return outcome(() => api.get('/echo-headers', { dedupe: false }));
    case 'problem':
      return outcome(() => api.get('/problem', { retry: false }));
    case 'timeout':
      // The response never starts: the client deadline ends the call.
      return outcome(() => api.get('/hang', { timeoutMs: 400, retry: false, dedupe: false }));
    case 'abort':
      // The caller's signal (POST: no de-duplication; the caller's signal is combined with the deadline).
      return outcome(() => api.post('/hang', { signal: abortAfter(200), retry: false, body: { x: 1 } }));
    case 'abort-get':
      // A de-duplicated GET: the caller's signal ends its subscription and the shared request.
      return outcome(() => api.get('/hang', { signal: abortAfter(200), retry: false }));
    case 'abort-body':
      // Headers arrive at once, the body after 2 s: the abort lands while the body is read.
      return outcome(() => api.get('/slow-body', { query: { ms: 2000 }, signal: abortAfter(400), retry: false, dedupe: false }));
    case 'timeout-with-signal': {
      // A caller signal that never aborts: the deadline must still end the call (it is combined with it).
      const keep = new AbortController();
      return outcome(() => api.get('/hang', { signal: keep.signal, timeoutMs: 400, retry: false, dedupe: false }));
    }
    case 'timeout-body':
      return outcome(() => api.get('/slow-body', { query: { ms: 2000 }, timeoutMs: 400, retry: false, dedupe: false }));
  }
}

/**
 * Makes `calls` successful POSTs with one long-lived caller signal (deadline `timeoutMs`) and counts the
 * 'abort' listeners left on that signal right after they settle and again after their deadlines.
 */
async function signalListeners(calls: number, timeoutMs: number) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
    if (type === 'abort') live++;
    add(type, l, o);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => {
    if (type === 'abort') live--;
    remove(type, l, o);
  }) as typeof signal.removeEventListener;
  const api = client();
  const results: HttpOutcome[] = [];
  for (let i = 0; i < calls; i++) results.push(await outcome(() => api.post('/ok', { signal, timeoutMs, retry: false })));
  const afterSettle = live;
  await sleep(timeoutMs + 300);
  const afterDeadline = live;
  // The caller aborts later (its component unmounts): nothing may throw.
  ctrl.abort();
  await sleep(50);
  return { ok: results.every((r) => r.ok), afterSettle, afterDeadline, hasAny: typeof AbortSignal.any === 'function' };
}

/** sanitizeHtml's result, and the DOM after assigning it to innerHTML. */
function sanitize(dirty: string) {
  const out = sanitizeHtml(dirty, { allowLinks: true });
  const tt = (globalThis as { trustedTypes?: { isHTML(v: unknown): boolean } }).trustedTypes;
  const div = document.createElement('div');
  div.innerHTML = out as string;
  document.body.append(div);
  return { type: typeof out, isTrustedHTML: tt?.isHTML(out) ?? false, html: div.innerHTML };
}

/** Assigns a plain string to innerHTML: under require-trusted-types-for 'script' it must throw. */
function assignRawHtml() {
  const div = document.createElement('div');
  try {
    div.innerHTML = '<b>raw</b>';
    return { threw: false, html: div.innerHTML };
  } catch (e) {
    return { threw: true, error: (e as Error).name };
  }
}

/** Builds a function from a string: under script-src 'self' it must throw (and report a violation). */
function tryEval() {
  try {
    const f = new Function('return 1') as () => number;
    return { threw: false, value: f() };
  } catch (e) {
    return { threw: true, error: (e as Error).name };
  }
}

async function sha256(text: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { isSecureContext, hasSubtle: false, hex: '' };
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return { isSecureContext, hasSubtle: true, hex: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

const channels = new Map<string, { ch: BroadcastChannel; received: unknown[] }>();

/** Opens (once) a BroadcastChannel and keeps every message it receives. */
function openChannel(name: string): boolean {
  if (typeof BroadcastChannel !== 'function') return false;
  if (!channels.has(name)) {
    const ch = new BroadcastChannel(name);
    const entry = { ch, received: [] as unknown[] };
    ch.addEventListener('message', (e) => entry.received.push(e.data));
    channels.set(name, entry);
  }
  return true;
}

const storageEvents: { key: string | null; newValue: string | null }[] = [];
addEventListener('storage', (e) => storageEvents.push({ key: e.key, newValue: e.newValue }));

/** The SDK's per-workspace storage, as after a sign-in to `realm` (/auth sets the namespace). */
function appStorage(realm: string) {
  getRuntime().storageNamespace = realm;
  return storage('harness');
}

// boot, sanitize, assignRawHtml and tryEval run in a page task (inTask): what they check depends on
// the page's CSP, which code started from page.evaluate may escape.
export const harness = {
  boot: (o?: BootOptions) => inTask(() => boot(o)),
  spans,
  logs,
  stats,
  setVisibility,
  count,
  inTask,
  requestsStartedInPagehide,
  http,
  signalListeners,
  sanitize: (dirty: string) => inTask(() => sanitize(dirty)),
  assignRawHtml: () => inTask(assignRawHtml),
  tryEval: () => inTask(tryEval),
  sha256,
  openChannel,
  post: (name: string, msg: unknown) => (openChannel(name), channels.get(name)!.ch.postMessage(msg)),
  received: (name: string) => channels.get(name)?.received ?? [],
  storageSet: (realm: string, key: string, value: unknown) => appStorage(realm).set(key, value),
  storageGet: (realm: string, key: string) => appStorage(realm).get(key),
  storageEvents: () => storageEvents,
  events: () => events,
  errors: () => pageErrors,
};

export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

window.harness = harness;
document.documentElement.dataset.harness = 'ready';
