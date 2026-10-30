// The platform HTTP client (design doc §C1 /http): one fixed request pipeline for every call,
// contract-compatible with platform-gincommon (headers, request ids, problems, timeouts).
import { getIdentity, getSessionId, newRequestId } from '../core/index.ts';
import { tryGetConfig } from '../config/index.ts';
import { FORBIDDEN_REQUEST_HEADERS } from '../internal/generated/forbidden-headers.ts';
import { getRuntime } from '../internal/runtime.ts';
import { getLogger } from '../logging/index.ts';
import {
  AbortedError,
  NetworkError,
  ProblemError,
  TimeoutError,
  parseProblemResponse,
} from '../problem/index.ts';
import { getTracer, injectTraceHeaders, type Span } from '../tracing/index.ts';
import { isOnline } from './online.ts';

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

/** Retry-After in ms (seconds or an HTTP-date), capped; undefined when absent or unparsable. */
function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const seconds = Number(v);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
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
}

const STANDARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

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
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    return await fetch(url, { method, headers, signal, ...(body === undefined ? {} : { body }) });
  } catch (e) {
    if (o.signal?.aborted) throw new AbortedError();
    if (timeout.aborted) throw new TimeoutError(timeoutMs, call.requestId);
    throw new NetworkError(!isOnline(), call.requestId, { cause: e });
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
        const wait = retryAfterMs(res) ?? backoffMs(n);
        await res.body?.cancel().catch(() => {});
        await sleep(wait, call.o.signal);
        continue;
      }

      if (!res.ok) throw await parseProblemResponse(res, { requestId: call.requestId });
      const data = await readData<T>(res);
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
    } else if (e instanceof AbortedError) {
      record(call, started, undefined, 'aborted');
    } else if (e instanceof TimeoutError) {
      record(call, started, undefined, 'timeout');
      call.span.recordError(e);
    } else if (e instanceof NetworkError) {
      record(call, started, undefined, 'network');
      call.span.recordError(e);
    }
    throw e;
  } finally {
    call.span.end();
  }
}

interface Shared {
  promise: Promise<ApiResponse<unknown>>;
  controller: AbortController;
  subscribers: number;
  aborted: number;
}

const inFlightGets = new Map<string, Shared>();

/** A subscriber's view of a shared GET: rejects with AbortedError when its own signal aborts. */
function subscribe<T>(shared: Shared, signal?: AbortSignal): Promise<ApiResponse<T>> {
  shared.subscribers++;
  if (!signal) return shared.promise as Promise<ApiResponse<T>>;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      shared.aborted++;
      if (shared.aborted === shared.subscribers) shared.controller.abort();
      reject(new AbortedError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r as ApiResponse<T>);
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
  const span = getTracer('@platform/frontend-sdk/http').startSpan(`HTTP ${method}`, {
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
      // Key: method + URL + who is asking (the token), so two users never share a response.
      const url = buildUrl(opts?.baseUrl ?? tryGetConfig()?.api.baseUrl ?? '/api', template, o.params, o.query);
      const probe = { o, url } as Call;
      const identity = (await currentToken(probe)) ?? '';
      const key = `GET ${url.href} ${o.auth === false ? '' : identity} ${JSON.stringify(o.headers ?? {})}`;
      let shared = inFlightGets.get(key);
      if (!shared) {
        const controller = new AbortController();
        const call = startCall(method, template, { ...o, signal: controller.signal }, opts?.baseUrl, mfe);
        const promise = execute<unknown>(call);
        shared = { promise, controller, subscribers: 0, aborted: 0 };
        inFlightGets.set(key, shared);
        const done = () => inFlightGets.delete(key);
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
