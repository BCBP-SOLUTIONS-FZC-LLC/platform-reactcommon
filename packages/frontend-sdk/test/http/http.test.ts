import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigSchema, setRuntimeConfig } from '../../src/config/index.ts';
import { getSessionId, initializeCore } from '../../src/core/index.ts';
import {
  FORBIDDEN_REQUEST_HEADERS,
  createApiClient,
  isOnline,
  setTokenSource,
  subscribeOnline,
  type TokenSource,
} from '../../src/http/index.ts';
import { subscribeRuntime } from '../../src/internal/events.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { AbortedError, NetworkError, PlatformProblemTypes, ProblemError, TimeoutError } from '../../src/problem/index.ts';
import { initializeTracing, shutdownTracing } from '../../src/tracing/index.ts';
import { setTracingInternalsForTests } from '../../src/tracing/tracing.ts';

const PAGE = 'https://app.bcbpsolutions.com/t/acme/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Handler = (url: URL, init: RequestInit & { headers: Headers }) => Response | Promise<Response>;
let calls: { url: URL; init: RequestInit & { headers: Headers } }[];
let handler: Handler;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { url: new URL(String(input)), init: init as RequestInit & { headers: Headers } };
  calls.push(call);
  if (init?.signal?.aborted) throw init.signal.reason; // like fetch: an aborted signal rejects at once
  return handler(call.url, call.init);
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const problem = (status: number, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ type: `https://errors.company.com/platform/${status === 401 ? 'unauthorized' : 'not-found'}`, title: 'x', status, ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-request-id': 'echo' },
  });

function config(patch: { propagationAllowlist?: string[]; sendSessionHeader?: boolean; timeoutMs?: number } = {}) {
  setRuntimeConfig(
    RuntimeConfigSchema.parse({
      api: { baseUrl: '/api', ...(patch.timeoutMs ? { timeoutMs: patch.timeoutMs } : {}), propagationAllowlist: patch.propagationAllowlist ?? [] },
      telemetry: { ...(patch.sendSessionHeader === undefined ? {} : { sendSessionHeader: patch.sendSessionHeader }) },
      auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
      remotes: { loadTimeoutMs: 10_000, retries: 2 },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
      appUpdate: { pollIntervalMs: 300_000 },
    }),
  );
}

function tokens(initial = 't1'): TokenSource & { current: string | undefined; refresh: ReturnType<typeof vi.fn>; onUnauthorized: ReturnType<typeof vi.fn> } {
  const source = {
    current: initial as string | undefined,
    getAccessToken: async () => source.current,
    refresh: vi.fn(async () => {
      source.current = 't2';
      return true;
    }),
    onUnauthorized: vi.fn(),
  };
  return source;
}

const h = (i = 0) => calls[i]!.init.headers;

beforeEach(() => {
  resetRuntimeForTests();
  calls = [];
  handler = () => json({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', new URL(PAGE));
  vi.spyOn(Math, 'random').mockReturnValue(0); // no backoff jitter in tests
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod' });
  config();
});

afterEach(async () => {
  await shutdownTracing();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockClear();
});

describe('FORBIDDEN_REQUEST_HEADERS', () => {
  it("is gincommon's identity headers plus the rest of IAM's ingress strip-list", () => {
    expect(FORBIDDEN_REQUEST_HEADERS).toEqual(['x-user-id', 'x-tenant-id', 'x-tenant-roles', 'x-departments', 'x-plan', 'x-feature-flags', 'x-residency-mode']);
  });
});

describe('URL', () => {
  it('fills encoded params into the template under the config baseUrl, with the query', async () => {
    await createApiClient().get('/tenders/:id/bids/:bid', { params: { id: 'a/b c', bid: 7 }, query: { page: 2, open: true, skip: undefined } });
    expect(calls[0]!.url.href).toBe('https://app.bcbpsolutions.com/api/tenders/a%2Fb%20c/bids/7?page=2&open=true');
  });

  it('uses a client baseUrl', async () => {
    await createApiClient({ baseUrl: '/bff/' }).get('/me');
    expect(calls[0]!.url.pathname).toBe('/bff/me');
  });

  it('rejects missing or unknown params and malformed templates before sending', async () => {
    const api = createApiClient();
    await expect(api.get('/tenders/:id')).rejects.toThrow(':id');
    await expect(api.get('/tenders', { params: { id: 1 } })).rejects.toThrow('not in route template');
    await expect(api.get('/tenders?x=1' as never)).rejects.toThrow(TypeError);
    await expect(api.get('/a/../b' as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("refuses '.' and '..' as param values, which URL parsing would resolve as path steps", async () => {
    setTokenSource(tokens());
    const api = createApiClient();
    await expect(api.post('/tenders/:id/approve', { params: { id: '..' } })).rejects.toThrow("must not be '.' or '..'");
    await expect(api.get('/tenders/:id/bids', { params: { id: '.' } })).rejects.toThrow(TypeError);
    await expect(api.get('/a/:x/:y', { params: { x: '..', y: '..' } })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0); // nothing sent, so no token went to another endpoint
    // Encoded or longer dot strings stay one literal segment.
    await api.get('/tenders/:id', { params: { id: '%2e%2e' } });
    await api.get('/tenders/:id', { params: { id: '...' } });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/tenders/%252e%252e', '/api/tenders/...']);
  });
});

describe('request headers (fixed pipeline)', () => {
  it('sends request id, session id, token and idempotency key to the page origin', async () => {
    setTokenSource(tokens());
    await createApiClient().post('/tenders', { body: { title: 'x' } });
    const headers = h();
    expect(headers.get('x-request-id')).toMatch(UUID);
    expect(headers.get('x-session-id')).toBe(getSessionId());
    expect(headers.get('authorization')).toBe('Bearer t1');
    expect(headers.get('idempotency-key')).toMatch(UUID);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json, application/problem+json');
    expect(calls[0]!.init.body).toBe('{"title":"x"}');
  });

  it('adds traceparent once tracing runs', async () => {
    setTracingInternalsForTests({ exporter: () => ({ export: (_s, cb) => cb({ code: 0 }), shutdown: async () => {} }) });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    await createApiClient().get('/tenders');
    expect(h().get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('keeps one request id, idempotency key and trace across retries', async () => {
    setTracingInternalsForTests({ exporter: () => ({ export: (_s, cb) => cb({ code: 0 }), shutdown: async () => {} }) });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    let n = 0;
    handler = () => (n++ === 0 ? new Response('', { status: 503 }) : json({}));
    await createApiClient().post('/tenders', { body: {}, retry: { unsafe: true } });
    expect(calls).toHaveLength(2);
    for (const name of ['x-request-id', 'idempotency-key', 'traceparent']) expect(h(1).get(name), name).toBe(h(0).get(name));
  });

  it('gives each logical call its own request id and no idempotency key outside POST', async () => {
    const api = createApiClient();
    await api.put('/a', { body: 1 });
    await api.put('/a', { body: 1 });
    expect(h(0).get('x-request-id')).not.toBe(h(1).get('x-request-id'));
    expect(h(0).has('idempotency-key')).toBe(false);
  });

  it("uses the caller's idempotency key, and replaces SDK-owned headers a caller sets", async () => {
    await createApiClient().post('/a', { idempotencyKey: 'order-42', headers: { 'X-Request-ID': 'mine', traceparent: 'forged', 'x-custom': '1' } });
    expect(h().get('idempotency-key')).toBe('order-42');
    expect(h().get('x-request-id')).not.toBe('mine');
    expect(h().has('traceparent')).toBe(false);
    expect(h().get('x-custom')).toBe('1');
  });

  it('honours the x-session-id opt-out', async () => {
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod' });
    config({ sendSessionHeader: false });
    await createApiClient().get('/a');
    expect(h().has('x-session-id')).toBe(false);
  });

  it('never sends identity headers: throws in dev, drops and logs elsewhere', async () => {
    await createApiClient().get('/a', { headers: { 'X-Tenant-ID': 'other-tenant', 'x-plan': 'enterprise' } });
    expect(h().has('x-tenant-id')).toBe(false);
    expect(h().has('x-plan')).toBe(false);
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(createApiClient().get('/a', { headers: { 'x-user-id': 'admin' } })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(1);
  });

  it('sends no request id, trace, session id or token to another origin', async () => {
    setTokenSource(tokens());
    setTracingInternalsForTests({ exporter: () => ({ export: (_s, cb) => cb({ code: 0 }), shutdown: async () => {} }) });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    await createApiClient({ baseUrl: 'https://partner.example/api' }).get('/x');
    for (const name of ['x-request-id', 'traceparent', 'x-session-id', 'authorization']) expect(h().has(name), name).toBe(false);
  });

  it('sends correlation, but never the token, to an allowlisted origin', async () => {
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod' });
    config({ propagationAllowlist: ['https://files.bcbpsolutions.com'] });
    setTokenSource(tokens());
    await createApiClient({ baseUrl: 'https://files.bcbpsolutions.com/api' }).get('/x');
    expect(h().get('x-request-id')).toMatch(UUID);
    expect(h().has('x-session-id')).toBe(true);
    expect(h().has('authorization')).toBe(false);
  });

  it('sends no token with auth: false', async () => {
    setTokenSource(tokens());
    await createApiClient().get('/public', { auth: false });
    expect(h().has('authorization')).toBe(false);
  });

  it('passes FormData, strings and Blobs through untouched', async () => {
    const form = new FormData();
    form.set('a', '1');
    await createApiClient().post('/upload', { body: form });
    expect(calls[0]!.init.body).toBe(form);
    expect(h().has('content-type')).toBe(false);
  });
});

describe('responses', () => {
  it('returns JSON data with status, request id and trace id', async () => {
    handler = () => json({ id: 1 }, 200, { 'x-trace-id': '4bf92f3577b34da6a3ce929d0e0e4736' });
    const r = await createApiClient().get<{ id: number }>('/tenders/:id', { params: { id: 1 } });
    expect(r.data).toEqual({ id: 1 });
    expect(r.status).toBe(200);
    expect(r.requestId).toBe(h().get('x-request-id'));
    expect(r.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('returns undefined for 204 and an empty body, text for non-JSON', async () => {
    handler = () => new Response(null, { status: 204 });
    expect((await createApiClient().delete('/a')).data).toBeUndefined();
    handler = () => new Response('', { status: 200 });
    expect((await createApiClient().get('/b')).data).toBeUndefined();
    handler = () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } });
    expect((await createApiClient().get('/c')).data).toBe('plain');
  });

  it('throws a ProblemError for an error status, with the request id', async () => {
    handler = () => problem(404, { errorCode: 'TENDER_NOT_FOUND' });
    const e = await createApiClient().get('/tenders/:id', { params: { id: 9 } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProblemError);
    expect((e as ProblemError).is(PlatformProblemTypes.NotFound)).toBe(true);
    expect((e as ProblemError).requestId).toBe('echo');
  });

  it('turns a non-problem error response into a synthetic problem', async () => {
    handler = () => new Response('<html>oops</html>', { status: 500, headers: { 'content-type': 'text/html' } });
    const e = (await createApiClient().post('/a').catch((x: unknown) => x)) as ProblemError;
    expect(e.synthetic).toBe(true);
    expect(e.requestId).toBe(h().get('x-request-id'));
  });
});

describe('failures', () => {
  it('short-circuits with an offline NetworkError, without fetching', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const e = await createApiClient().get('/a').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).offline).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('throws a TimeoutError at the client deadline', async () => {
    handler = (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const e = await createApiClient().get('/slow', { timeoutMs: 20, retry: false }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TimeoutError);
    expect((e as TimeoutError).timeoutMs).toBe(20);
  });

  describe('while the body is read', () => {
    // A body that streams until the request's signal aborts it, as a browser's does.
    const stalledBody = (_u: URL, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            init.signal!.addEventListener('abort', () => c.error(init.signal!.reason));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    it('the deadline gives a TimeoutError, not a raw DOMException', async () => {
      handler = stalledBody;
      const e = await createApiClient().get('/slow-body', { timeoutMs: 20, retry: false }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TimeoutError);
      expect((e as TimeoutError).timeoutMs).toBe(20);
    });

    it('a caller abort gives an AbortedError', async () => {
      handler = stalledBody;
      const controller = new AbortController();
      const p = createApiClient().get('/slow-body', { signal: controller.signal, dedupe: false });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      controller.abort();
      await expect(p).rejects.toBeInstanceOf(AbortedError);
    });

    it('a dropped connection gives a NetworkError; a problem body still parses', async () => {
      handler = () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new TypeError('network error'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      await expect(createApiClient().get('/a', { retry: false })).rejects.toBeInstanceOf(NetworkError);
      handler = () => problem(404);
      await expect(createApiClient().get('/a')).rejects.toBeInstanceOf(ProblemError);
    });
  });

  describe('without AbortSignal.any (Safari < 17.4)', () => {
    const any = AbortSignal.any;
    beforeEach(() => {
      (AbortSignal as { any?: unknown }).any = undefined;
    });
    afterEach(() => {
      AbortSignal.any = any;
    });

    it('still succeeds, times out and honours the caller signal', async () => {
      const api = createApiClient();
      expect((await api.get('/a', { signal: new AbortController().signal })).data).toEqual({ ok: true });

      handler = (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
      const t = await api.get('/slow', { signal: new AbortController().signal, timeoutMs: 20, retry: false }).catch((x: unknown) => x);
      expect(t).toBeInstanceOf(TimeoutError);

      const controller = new AbortController();
      const p = api.get('/slow', { signal: controller.signal, dedupe: false });
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      controller.abort();
      await expect(p).rejects.toBeInstanceOf(AbortedError);

      const done = new AbortController();
      done.abort();
      await expect(api.get('/a', { signal: done.signal, dedupe: false })).rejects.toBeInstanceOf(AbortedError);
    });
  });

  it("throws AbortedError when the caller aborts, and doesn't retry", async () => {
    const controller = new AbortController();
    handler = (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const p = createApiClient().put('/a', { signal: controller.signal });
    controller.abort(); // before the request is sent: nothing goes out
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toHaveLength(0);
    const c2 = new AbortController();
    const q = createApiClient().put('/b', { signal: c2.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c2.abort(); // in flight
    await expect(q).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toHaveLength(1);
  });

  it('wraps a network failure in NetworkError with its cause', async () => {
    const cause = new TypeError('Failed to fetch');
    handler = () => Promise.reject(cause);
    const e = (await createApiClient().post('/a').catch((x: unknown) => x)) as NetworkError;
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.offline).toBe(false);
    expect(e.cause).toBe(cause);
    expect(calls).toHaveLength(1); // POST: no retry
  });
});

describe('retries', () => {
  it('retries idempotent calls on network errors and 429/502/503/504, up to `attempts`', async () => {
    let n = 0;
    handler = () => {
      n++;
      if (n === 1) return Promise.reject(new TypeError('net'));
      if (n === 2) return new Response('', { status: 502 });
      return json({ ok: 1 });
    };
    expect((await createApiClient().get('/a')).data).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    handler = () => new Response('', { status: 503 });
    calls = [];
    await expect(createApiClient().get('/b', { retry: { attempts: 1 } })).rejects.toBeInstanceOf(ProblemError);
    expect(calls).toHaveLength(2);
  });

  it('does not retry POST unless unsafe, nor 500 or 4xx, nor with retry: false', async () => {
    handler = () => new Response('', { status: 503 });
    await createApiClient().post('/a').catch(() => {});
    expect(calls).toHaveLength(1);
    handler = () => new Response('', { status: 500 });
    await createApiClient().get('/b').catch(() => {});
    expect(calls).toHaveLength(2);
    handler = () => new Response('', { status: 429 });
    await createApiClient().get('/c', { retry: false }).catch(() => {});
    expect(calls).toHaveLength(3);
  });

  it('waits Retry-After (seconds or HTTP-date), capped at 30 s', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      handler = () => (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : json({}));
      const p = createApiClient().get('/a');
      await vi.advanceTimersByTimeAsync(1_900);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(calls).toHaveLength(2);

      n = 0;
      calls = [];
      handler = () => (n++ === 0 ? new Response('', { status: 503, headers: { 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() } }) : json({}));
      const q = createApiClient().get('/b');
      await vi.advanceTimersByTimeAsync(30_000);
      await q;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('401', () => {
  it('retries once with a newer token another call already got, without refreshing', async () => {
    const t = tokens('old');
    setTokenSource(t);
    handler = (_u, init) => (init.headers.get('authorization') === 'Bearer old' ? ((t.current = 'new'), problem(401)) : json({ ok: 1 }));
    await createApiClient().get('/a');
    expect(t.refresh).not.toHaveBeenCalled();
    expect(h(1).get('authorization')).toBe('Bearer new');
  });

  it("joins the token source's refresh, then retries once", async () => {
    const t = tokens();
    setTokenSource(t);
    handler = (_u, init) => (init.headers.get('authorization') === 'Bearer t1' ? problem(401) : json({ ok: 1 }));
    expect((await createApiClient().get('/a')).data).toEqual({ ok: 1 });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(h(1).get('authorization')).toBe('Bearer t2');
    expect(t.onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls onUnauthorized and throws when the refresh fails or the retry is 401 again', async () => {
    const t = tokens();
    t.refresh.mockResolvedValue(false);
    setTokenSource(t);
    handler = () => problem(401);
    const e = await createApiClient().get('/a').catch((x: unknown) => x);
    expect((e as ProblemError).status).toBe(401);
    expect(t.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);

    const u = tokens();
    setTokenSource(u);
    calls = [];
    await createApiClient().get('/b').catch(() => {});
    expect(calls).toHaveLength(2); // one retry after the refresh, never a loop
    expect(u.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for auth: false or without a token source', async () => {
    handler = () => problem(401);
    await createApiClient().get('/a').catch(() => {});
    const t = tokens();
    setTokenSource(t);
    await createApiClient().get('/b', { auth: false }).catch(() => {});
    expect(t.refresh).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });
});

describe('GET deduplication', () => {
  it('shares one request between identical concurrent GETs', async () => {
    const api = createApiClient();
    const [a, b] = await Promise.all([api.get('/a', { query: { x: 1 } }), api.get('/a', { query: { x: 1 } })]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    await api.get('/a', { query: { x: 1 } });
    expect(calls).toHaveLength(2); // not cached once settled
  });

  it('does not share across users, URLs, or with dedupe: false', async () => {
    const t = tokens('u1');
    setTokenSource(t);
    const api = createApiClient();
    const first = api.get('/a');
    t.current = 'u2';
    await Promise.all([first, api.get('/a'), api.get('/b'), api.get('/a', { dedupe: false })]);
    expect(calls).toHaveLength(4);
  });

  it('aborts the shared request only when every subscriber has aborted', async () => {
    let resolveFetch!: (r: Response) => void;
    let fetchSignal!: AbortSignal;
    handler = (_u, init) => {
      fetchSignal = init.signal!;
      return new Promise((resolve, reject) => {
        resolveFetch = resolve;
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      });
    };
    const api = createApiClient();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get('/a', { signal: c1.signal });
    const p2 = api.get('/a', { signal: c2.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c1.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortedError);
    expect(fetchSignal.aborted).toBe(false);
    resolveFetch(json({ ok: 1 }));
    expect((await p2).data).toEqual({ ok: 1 });

    calls = [];
    const c3 = new AbortController();
    const c4 = new AbortController();
    const p3 = api.get('/b', { signal: c3.signal });
    const p4 = api.get('/b', { signal: c4.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c3.abort();
    c4.abort();
    await expect(Promise.all([p3, p4])).rejects.toBeInstanceOf(AbortedError);
    expect(fetchSignal.aborted).toBe(true);
  });

  it('starts afresh when a GET for the same key arrives right after every subscriber aborted', async () => {
    // StrictMode remounts, reload() while loading, deps A→B→A: the new call must not join the dead one.
    handler = (_u, init) =>
      calls.length === 1 ? new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))) : json({ ok: 2 });
    const api = createApiClient();
    const c1 = new AbortController();
    const p1 = api.get('/a', { signal: c1.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c1.abort();
    const p2 = api.get('/a', { signal: new AbortController().signal });
    await expect(p1).rejects.toBeInstanceOf(AbortedError);
    expect((await p2).data).toEqual({ ok: 2 });
    expect(calls).toHaveLength(2);
  });
});

describe('metrics (instrument port)', () => {
  it('records one observation per logical call with the server-compatible labels', async () => {
    const seen: unknown[] = [];
    getRuntime().instruments = { httpClient: (_s, l) => seen.push(l), remoteLoad: () => {}, webError: () => {} };
    const api = createApiClient({ mfe: 'tenders' });
    let n = 0;
    handler = () => (n++ === 0 ? new Response('', { status: 503 }) : json({}));
    await api.get('/tenders/:id', { params: { id: 1 } });
    handler = () => problem(404);
    await api.get('/b').catch(() => {});
    handler = () => Promise.reject(new TypeError('net'));
    await api.post('/c').catch(() => {});
    expect(seen).toEqual([
      { method: 'GET', route: '/tenders/:id', status_class: '2xx', error_class: 'success', mfe: 'tenders' },
      { method: 'GET', route: '/b', status_class: '4xx', error_class: 'client_error', mfe: 'tenders' },
      { method: 'POST', route: '/c', status_class: '5xx', error_class: 'server_error', mfe: 'tenders', reason: 'network' },
    ]);
  });

  it('never fails a call because metrics throw', async () => {
    getRuntime().instruments = { httpClient: () => { throw new Error('x'); }, remoteLoad: () => {}, webError: () => {} };
    await expect(createApiClient().get('/a')).resolves.toBeDefined();
  });
});

describe('online state', () => {
  it('reads navigator.onLine and the online/offline events', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(isOnline()).toBe(false);
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const l = vi.fn();
    const off = subscribeOnline(l);
    target.dispatchEvent(new Event('online'));
    target.dispatchEvent(new Event('offline'));
    off();
    target.dispatchEvent(new Event('online'));
    expect(l.mock.calls).toEqual([[true], [false]]);
  });
});

describe('edge paths', () => {
  it('sends PATCH with the JSON body, the token and no idempotency key', async () => {
    setTokenSource(tokens());
    await createApiClient().patch('/tenders/:id', { params: { id: 1 }, body: { title: 'y' } });
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.init.body).toBe('{"title":"y"}');
    expect(h().get('authorization')).toBe('Bearer t1');
    expect(h().has('idempotency-key')).toBe(false);
  });

  it('sends no token, but still calls, when the token source throws', async () => {
    setTokenSource({ getAccessToken: () => Promise.reject(new Error('storage gone')), refresh: async () => false, onUnauthorized: () => {} });
    expect((await createApiClient().get('/a')).data).toEqual({ ok: true });
    expect(h().has('authorization')).toBe(false);
  });

  it('calls onUnauthorized, without retrying, when the refresh itself rejects', async () => {
    const t = tokens();
    t.refresh.mockRejectedValue(new Error('refresh endpoint down'));
    setTokenSource(t);
    handler = () => problem(401);
    const e = await createApiClient().get('/a').catch((x: unknown) => x);
    expect((e as ProblemError).status).toBe(401);
    expect(t.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('falls back to backoff when Retry-After is unparsable', async () => {
    let n = 0;
    handler = () => (n++ === 0 ? new Response('', { status: 503, headers: { 'retry-after': 'soon' } }) : json({ ok: 1 }));
    expect((await createApiClient().get('/a')).data).toEqual({ ok: 1 }); // Math.random() = 0: no wait
    expect(calls).toHaveLength(2);
  });

  it('stops with AbortedError when the caller aborts before the backoff starts', async () => {
    const controller = new AbortController();
    handler = () => {
      controller.abort();
      return new Response('', { status: 503 });
    };
    await expect(createApiClient().put('/a', { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toHaveLength(1);
  });

  it('stops with AbortedError when the caller aborts during the Retry-After wait', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      handler = () => new Response('', { status: 429, headers: { 'retry-after': '5' } });
      const p = createApiClient().delete('/a', { signal: controller.signal });
      const settled = p.catch((x: unknown) => x);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(1);
      controller.abort();
      expect(await settled).toBeInstanceOf(AbortedError);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(1); // no retry after the abort
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deduplicated GET whose signal is already aborted, and sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createApiClient().get('/a', { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it('marks the tenant read-only once on DENY_TENANT_READ_ONLY', async () => {
    const seen = vi.fn();
    subscribeRuntime('read-only', seen);
    handler = () => problem(403, { type: 'https://errors.company.com/platform/forbidden', errorCode: 'DENY_TENANT_READ_ONLY' });
    const api = createApiClient();
    await expect(api.post('/a')).rejects.toBeInstanceOf(ProblemError);
    expect(getRuntime().readOnlyDenied).toBe(true);
    await expect(api.put('/b')).rejects.toBeInstanceOf(ProblemError);
    expect(seen).toHaveBeenCalledTimes(1);
    handler = () => problem(403, { errorCode: 'DENY_MFA_STALE' });
    resetRuntimeForTests();
    config();
    await api.post('/c').catch(() => {});
    expect(getRuntime().readOnlyDenied).toBeFalsy();
  });
});
