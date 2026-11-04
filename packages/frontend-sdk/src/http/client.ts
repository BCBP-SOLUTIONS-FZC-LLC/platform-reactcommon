// The platform HTTP client (design doc §C1 /http): one fixed request pipeline for every call,
// contract-compatible with platform-gincommon (headers, request ids, problems, timeouts).
import { getIdentity, getSessionId, newRequestId } from '../core/index.ts';
import { tryGetConfig } from '../config/index.ts';
import { emitRuntime } from '../internal/events.ts';
import { FORBIDDEN_REQUEST_HEADERS } from '../internal/generated/forbidden-headers.ts';
import { getRuntime } from '../internal/runtime.ts';
import { getLogger } from '../logging/index.ts';
import {
  AbortedError,
  NetworkError,
  ProblemError,
  TimeoutError,
  gatewayDenyCode,
  parseProblemResponse,
} from '../problem/index.ts';
import { bindTraceContext, getTracer, injectTraceHeaders, type Span } from '../tracing/index.ts';
import { isOnline } from '../internal/online.ts';
import { retryAfterMs } from '../internal/retry-after.ts';

export { FORBIDDEN_REQUEST_HEADERS };

/** How /http gets access tokens. Implemented by /auth; refresh() is single-flight per tab. */
export interface TokenSource {
  getAccessToken(): Promise<string | undefined>;
  refresh(): Promise<boolean>;
  onUnauthorized(): void;
}

export interface RequestOptions<B = unknown> {
  /** Fills :name segments of the template (URI-encoded). */
  params?: Record<string, string | number>;
  /** Query string; undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-encoded unless a FormData, Blob, URLSearchParams, ArrayBuffer or string. */
  body?: B;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Client deadline per attempt; default the config's api.timeoutMs (35 s). */
  timeoutMs?: number;
  /** Retries after the first attempt (default 2); POST retries only with unsafe: true. false disables. */
  retry?: false | { attempts?: number; unsafe?: boolean };
  /** POST only; default a new UUID per logical call, reused across its retries. */
  idempotencyKey?: string;
  /** GET only, default true: identical concurrent GETs share one request. */
  dedupe?: boolean;
  /** Send the access token (same origin only); default true. */
  auth?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** The x-request-id sent (the server echoes it as X-Request-ID). */
  requestId: string;
  /** X-Trace-ID from the response, when present. */
  traceId?: string;
}

/** An API route template, e.g. '/tenders/:id'. It is also the metric `route` label, never a raw URL. */
export type RouteTemplate = `/${string}`;

export interface ApiClient {
  get<T>(template: RouteTemplate, o?: RequestOptions): Promise<ApiResponse<T>>;
  post<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  put<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  patch<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  delete<T>(template: RouteTemplate, o?: RequestOptions): Promise<ApiResponse<T>>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const RETRY_AFTER_CAP_MS = 30_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT: ReadonlySet<Method> = new Set(['GET', 'PUT', 'DELETE']);
const FORBIDDEN = new Set<string>(FORBIDDEN_REQUEST_HEADERS);
// Set by the SDK only; a caller's value is replaced.
const SDK_HEADERS = new Set(['x-request-id', 'traceparent', 'tracestate', 'baggage', 'x-session-id', 'idempotency-key']);

/** Shell only: where /http gets tokens (/auth's initializeAuth returns one). */
export function setTokenSource(t: TokenSource): void {
  getRuntime().tokenSource = t;
}

function tokenSource(): TokenSource | undefined {
  return getRuntime().tokenSource as TokenSource | undefined;
}

function isDev(): boolean {
  const env = getIdentity()?.environment;
  return env === undefined || env === 'local' || env === 'dev';
}

function pageOrigin(): string | undefined {
  return globalThis.location?.origin;
}

/** Same origin as the page, or (outside a browser) a relative base. */
function isSameOrigin(url: URL): boolean {
  const origin = pageOrigin();
  return origin === undefined ? url.hostname === 'localhost' : url.origin === origin;
}

function allowlisted(url: URL): boolean {
  return (tryGetConfig()?.api.propagationAllowlist ?? []).includes(url.origin);
}

/** baseUrl + template, with :params filled (encoded) and the query appended. */
function buildUrl(baseUrl: string, template: string, params?: RequestOptions['params'], query?: RequestOptions['query']): URL {
  if (typeof template !== 'string' || !/^\/[^?#\s]*$/.test(template) || template.split('/').includes('..')) {
    throw new TypeError(`route template must be a path such as '/tenders/:id' (no query, fragment or '..'), got ${JSON.stringify(template)}`);
  }
  const used = new Set<string>();
  const path = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') throw new TypeError(`route template ${template} needs param :${name}`);
    // encodeURIComponent keeps '.' and '..', which URL parsing would resolve as path steps (a value of
    // '..' would send the call, with the token, to another endpoint).
    if (String(v) === '.' || String(v) === '..') throw new TypeError(`param :${name} of ${template} must not be '.' or '..'`);
    used.add(name);
    return encodeURIComponent(String(v));
  });
  for (const name of Object.keys(params ?? {})) {
    if (!used.has(name)) throw new TypeError(`param ${name} is not in route template ${template}`);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost/');
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.append(k, String(v));
  return url;
}

function encodeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string' || body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams || body instanceof ArrayBuffer) {
    return body;
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return JSON.stringify(body);
}

/** min(cap, base·2^n) with full jitter. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A signal that aborts when `a` or `b` does, and a release that detaches it. Never the native
 * AbortSignal.any: WebKit's loses the source's abort while the page collects garbage, so a caller's
 * abort and the deadline next to a caller signal never reached fetch (test/browser http.spec.ts). By
 * hand instead, with listeners that release() removes once the call is over (body read included), so
 * a long-lived caller signal does not collect one listener per call.
 */
export function anySignal(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release: () => void } {
  const c = new AbortController();
  const release = () => {
    a.removeEventListener('abort', onA);
    b.removeEventListener('abort', onB);
  };
  const stop = (s: AbortSignal) => () => {
    release();
    c.abort(s.reason);
  };
  const onA = stop(a);
  const onB = stop(b);
  if (a.aborted) onA();
  else if (b.aborted) onB();
  else {
    a.addEventListener('abort', onA, { once: true });
    b.addEventListener('abort', onB, { once: true });
  }
  return { signal: c.signal, release };
}

/** A failure while the request or its body was in flight, as the SDK's error type. */
function transportError(call: Call, e: unknown): AbortedError | TimeoutError | NetworkError {
  if (call.o.signal?.aborted) return new AbortedError();
  if (call.deadline?.signal.aborted) return new TimeoutError(call.deadline.ms, call.requestId);
  return new NetworkError(!isOnline(), call.requestId, { cause: e });
}

async function readData<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (/\bjson\b/i.test(type)) return JSON.parse(text) as T;
  return text as T;
}

interface Call {
  method: Method;
  template: RouteTemplate;
  url: URL;
  o: RequestOptions;
  requestId: string;
  idempotencyKey: string | undefined;
  mfe: string;
  span: Span;
  /** The current attempt's deadline: it still applies while the body is read. */
  deadline?: { signal: AbortSignal; ms: number };
  /** Detaches the current attempt's combined signal from the caller's; called when the call ends. */
  release?: (() => void) | undefined;
}

const STANDARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

/** At most this many no-response logs per page per window; the rest are counted into the next one. */
const NO_RESPONSE_LOGS = 10;
const NO_RESPONSE_WINDOW_MS = 60_000;
const noResponse = { windowStart: -Infinity, logged: 0, suppressed: 0 };

/**
 * An essential warning for a call that got no HTTP answer (timeout, or a network failure while online):
 * the server never sees these, so without it they would show only in sampled, consented spans.
 * Rate-limited per page, so a flaky connection cannot flood the pipeline; offline failures are not
 * logged (the user's own connection, and the log could not leave anyway).
 */
function logNoResponse(call: Call, reason: 'timeout' | 'network'): void {
  const now = Date.now();
  if (now - noResponse.windowStart >= NO_RESPONSE_WINDOW_MS) {
    noResponse.windowStart = now;
    noResponse.logged = 0;
  }
  if (noResponse.logged >= NO_RESPONSE_LOGS) {
    noResponse.suppressed++;
    return;
  }
  noResponse.logged++;
  const suppressed = noResponse.suppressed;
  noResponse.suppressed = 0;
  getLogger({ mfe: call.mfe }).warn('api call got no response', {
    method: call.method,
    route: call.template,
    reason,
    request_id: call.requestId,
    ...(suppressed > 0 ? { suppressed } : {}),
    essential: true,
  });
}

/** Test only: forget the no-response log rate limit. */
export function resetNoResponseLogForTests(): void {
  Object.assign(noResponse, { windowStart: -Infinity, logged: 0, suppressed: 0 });
}

function record(call: Call, started: number, status: number | undefined, reason?: 'timeout' | 'network' | 'aborted'): void {
  const seconds = (performance.now() - started) / 1000;
  let status_class: '2xx' | '4xx' | '5xx';
  let error_class: 'success' | 'client_error' | 'server_error';
  if (status !== undefined) {
    status_class = status < 400 ? '2xx' : status < 500 ? '4xx' : '5xx';
    error_class = status < 400 ? 'success' : status < 500 ? 'client_error' : 'server_error';
  } else if (reason === 'aborted') {
    status_class = '4xx'; // like the server's 499 for a client abort
    error_class = 'client_error';
  } else {
    status_class = '5xx';
    error_class = 'server_error';
  }
  try {
    getRuntime().instruments.httpClient(seconds, {
      method: STANDARD_METHODS.has(call.method) ? call.method : 'OTHER',
      route: call.template,
      status_class,
      error_class,
      mfe: call.mfe,
      ...(reason ? { reason } : {}),
    });
  } catch {
    // metrics never break a call
  }
}

/** One fetch of the call: headers in the doc's fixed order, then the deadline. */
async function attempt(call: Call, token: string | undefined): Promise<Response> {
  const { o, url, method } = call;
  if (o.signal?.aborted) throw new AbortedError();
  if (!isOnline()) throw new NetworkError(true, call.requestId);

  const headers = new Headers();
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const name = k.toLowerCase();
    if (FORBIDDEN.has(name)) {
      if (isDev()) throw new TypeError(`header ${name} is set by the gateway from the verified token; the browser never sends it`);
      getLogger().warn('dropped a forbidden request header', { header: name, route: call.template, essential: true });
      continue;
    }
    if (SDK_HEADERS.has(name)) continue;
    headers.set(name, v);
  }
  headers.set('accept', 'application/json, application/problem+json');
  const correlated = isSameOrigin(url) || allowlisted(url);
  if (correlated) headers.set('x-request-id', call.requestId);
  injectTraceHeaders(url, headers, call.span);
  if (correlated && (tryGetConfig()?.telemetry.sendSessionHeader ?? true)) headers.set('x-session-id', getSessionId());
  if (token && isSameOrigin(url)) headers.set('authorization', `Bearer ${token}`);
  if (call.idempotencyKey) headers.set('idempotency-key', call.idempotencyKey);
  const body = encodeBody(o.body, headers);

  const timeoutMs = o.timeoutMs ?? tryGetConfig()?.api.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  call.deadline = { signal: timeout, ms: timeoutMs };
  call.release?.();
  const combined = o.signal ? anySignal(o.signal, timeout) : undefined;
  call.release = combined?.release;
  const signal = combined?.signal ?? timeout;
  try {
    return await fetch(url, { method, headers, signal, ...(body === undefined ? {} : { body }) });
  } catch (e) {
    throw transportError(call, e);
  }
}

async function currentToken(call: Call): Promise<string | undefined> {
  if (call.o.auth === false || !isSameOrigin(call.url)) return undefined;
  try {
    return await tokenSource()?.getAccessToken();
  } catch {
    return undefined;
  }
}

/** The whole logical call: attempts, the 401 path, retries, then data or an ApiError. */
async function execute<T>(call: Call): Promise<ApiResponse<T>> {
  const started = performance.now();
  const retries = call.o.retry === false ? 0 : Math.max(0, call.o.retry?.attempts ?? DEFAULT_RETRIES);
  const retryable = IDEMPOTENT.has(call.method) || (call.o.retry !== false && call.o.retry?.unsafe === true);
  let token = await currentToken(call);
  let refreshed = false;
  try {
    for (let n = 0; ; n++) {
      let res: Response;
      try {
        res = await attempt(call, token);
      } catch (e) {
        const transient = (e instanceof NetworkError && !e.offline) || e instanceof TimeoutError;
        if (transient && retryable && n < retries) {
          await sleep(backoffMs(n), call.o.signal);
          continue;
        }
        throw e;
      }

      if (res.status === 401 && !refreshed && call.o.auth !== false && tokenSource()) {
        refreshed = true;
        // A newer token may already exist (another call refreshed); else join the single refresh.
        let next = await currentToken(call);
        if (next === token || next === undefined) next = (await tokenSource()!.refresh().catch(() => false)) ? await currentToken(call) : undefined;
        if (next !== undefined && next !== token) {
          await res.body?.cancel().catch(() => {});
          token = next;
          n--; // the retry after a refresh is not a transient-failure retry
          continue;
        }
        tokenSource()!.onUnauthorized();
      }

      if (RETRY_STATUSES.has(res.status) && retryable && n < retries) {
        const wait = retryAfterMs(res, RETRY_AFTER_CAP_MS) ?? backoffMs(n);
        await res.body?.cancel().catch(() => {});
        await sleep(wait, call.o.signal);
        continue;
      }

      // The body is read under the same deadline and signal as the fetch: its failures get the same types.
      let data: T;
      try {
        if (!res.ok) throw await parseProblemResponse(res, { requestId: call.requestId });
        data = await readData<T>(res);
      } catch (e) {
        if (e instanceof ProblemError || e instanceof SyntaxError) throw e;
        throw transportError(call, e);
      }
      record(call, started, res.status);
      call.span.setAttribute('http.response.status_code', res.status);
      const traceId = res.headers.get('x-trace-id') ?? undefined;
      return { data, status: res.status, headers: res.headers, requestId: call.requestId, ...(traceId ? { traceId } : {}) };
    }
  } catch (e) {
    if (e instanceof ProblemError) {
      record(call, started, e.status);
      call.span.setAttribute('http.response.status_code', e.status);
      if (e.status >= 500) call.span.recordError(e);
      if (gatewayDenyCode(e) === 'DENY_TENANT_READ_ONLY' && !getRuntime().readOnlyDenied) {
        getRuntime().readOnlyDenied = true; // the tenant is read-only now, whatever the session context said (useReadOnly)
        emitRuntime('read-only');
      }
    } else if (e instanceof AbortedError) {
      record(call, started, undefined, 'aborted');
    } else if (e instanceof TimeoutError) {
      record(call, started, undefined, 'timeout');
      call.span.recordError(e);
      logNoResponse(call, 'timeout');
    } else if (e instanceof NetworkError) {
      record(call, started, undefined, 'network');
      call.span.recordError(e);
      if (!e.offline) logNoResponse(call, 'network');
    }
    throw e;
  } finally {
    call.release?.();
    call.span.end();
  }
}

interface Shared {
  key: string;
  promise: Promise<ApiResponse<unknown>>;
  controller: AbortController;
  subscribers: number;
  aborted: number;
}

const inFlightGets = new Map<string, Shared>();

/** A deep copy of a response's data (parsed JSON, text or undefined); status, headers etc. are kept. */
function copyData(r: ApiResponse<unknown>): ApiResponse<unknown> {
  const d = r.data;
  if (typeof d !== 'object' || d === null) return r;
  return { ...r, data: typeof structuredClone === 'function' ? structuredClone(d) : (JSON.parse(JSON.stringify(d)) as unknown) };
}

/**
 * A subscriber's view of a shared GET: rejects with AbortedError when its own signal aborts. The
 * first subscriber gets the response itself, later ones a copy of its data, so one caller
 * mutating it (e.g. sorting in place) never changes what the others see.
 */
function subscribe<T>(shared: Shared, signal?: AbortSignal): Promise<ApiResponse<T>> {
  const own = shared.subscribers++ === 0 ? (r: ApiResponse<unknown>) => r : copyData;
  if (!signal) return shared.promise.then(own) as Promise<ApiResponse<T>>;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      shared.aborted++;
      if (shared.aborted === shared.subscribers) {
        // Nobody wants it any more: a new GET for the same key must start afresh, not join a dead request.
        if (inFlightGets.get(shared.key) === shared) inFlightGets.delete(shared.key);
        shared.controller.abort();
      }
      reject(new AbortedError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(own(r) as ApiResponse<T>);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function startCall(method: Method, template: RouteTemplate, o: RequestOptions, baseUrl: string | undefined, mfe: string): Call {
  const url = buildUrl(baseUrl ?? tryGetConfig()?.api.baseUrl ?? '/api', template, o.params, o.query);
  const span = getTracer('@bcbp-solutions-fzc-llc/frontend-sdk/http').startSpan(`HTTP ${method}`, {
    'http.request.method': method,
    'url.template': template,
    mfe,
  });
  return {
    method,
    template,
    url,
    o,
    requestId: newRequestId(),
    idempotencyKey: method === 'POST' ? (o.idempotencyKey ?? newRequestId()) : undefined,
    mfe,
    span,
  };
}

/**
 * An API client. `baseUrl` defaults to the runtime config's api.baseUrl ('/api'); `mfe` tags its
 * spans and metrics (default 'shell'). Calls never send identity headers, send the access token
 * only to the page's own origin, and fail with ProblemError, TimeoutError, NetworkError or
 * AbortedError.
 */
export function createApiClient(opts?: { baseUrl?: string; mfe?: string }): ApiClient {
  const mfe = opts?.mfe ?? 'shell';
  const request = async <T>(method: Method, template: RouteTemplate, o: RequestOptions = {}): Promise<ApiResponse<T>> => {
    if (method === 'GET' && o.dedupe !== false) {
      // The token is awaited for the key: bind the request span to the caller's span first.
      const start = bindTraceContext(startCall);
      // Key: method + URL + who is asking (the token), so two users never share a response.
      const url = buildUrl(opts?.baseUrl ?? tryGetConfig()?.api.baseUrl ?? '/api', template, o.params, o.query);
      const probe = { o, url } as Call;
      const identity = (await currentToken(probe)) ?? '';
      const key = `GET ${url.href} ${o.auth === false ? '' : identity} ${JSON.stringify(o.headers ?? {})}`;
      let shared = inFlightGets.get(key);
      if (!shared) {
        const controller = new AbortController();
        const call = start(method, template, { ...o, signal: controller.signal }, opts?.baseUrl, mfe);
        const promise = execute<unknown>(call);
        const entry: Shared = { key, promise, controller, subscribers: 0, aborted: 0 };
        shared = entry;
        inFlightGets.set(key, entry);
        const done = () => {
          if (inFlightGets.get(key) === entry) inFlightGets.delete(key);
        };
        promise.then(done, done);
      }
      return subscribe<T>(shared, o.signal);
    }
    return execute<T>(startCall(method, template, o, opts?.baseUrl, mfe));
  };
  return {
    get: (template, o) => request('GET', template, o),
    post: (template, o) => request('POST', template, o),
    put: (template, o) => request('PUT', template, o),
    patch: (template, o) => request('PATCH', template, o),
    delete: (template, o) => request('DELETE', template, o),
  };
}
