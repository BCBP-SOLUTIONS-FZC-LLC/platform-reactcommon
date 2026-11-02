// The shell's bootstrap wired end to end in-process (design doc §C2): core → runtime config (fetched)
// → consent → tracing, logging, metrics → auth with a fake Keycloak, then the ApiClient and the
// logger correlating one call through the headers it sends and the records that leave the page.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSession } from '../../packages/frontend-sdk/src/auth/index.ts';
import { getSessionId } from '../../packages/frontend-sdk/src/core/index.ts';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { getLogger } from '../../packages/frontend-sdk/src/logging/index.ts';
import { withSpan } from '../../packages/frontend-sdk/src/tracing/index.ts';
import { ACME, World, endWorld, useFakeClock } from '../fixtures/boot.ts';
import { ORIGIN } from '../fixtures/keycloak.ts';
import { unloadTelemetry } from '../fixtures/telemetry.ts';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

/** Echoes X-Request-ID as gincommon's RequestID middleware does. */
const echo = (body: unknown) => (req: Request) => Response.json(body, { headers: { 'x-request-id': req.headers.get('x-request-id') ?? '' } });

let w: World;

beforeEach(() => {
  useFakeClock();
  w = new World('/t/acme/tenders');
  w.net.on('GET /api/tenders/:id', echo({ id: '1', title: 'Road works' })).on('POST /api/tenders', echo({ id: '2' }));
});

afterEach(endWorld);

describe('bootstrap', () => {
  it('loads the runtime config first, starts all three signals on it, and signs in with PKCE', async () => {
    const session = await w.signIn(ACME, '/t/acme/tenders?tab=open');

    // Each page load (the login page, then the callback) fetched the config before anything else.
    expect(w.net.requests.map((r) => new URL(r.url).pathname)).toEqual(['/config/runtime.json', '/config/runtime.json']);
    expect(w.collector.urls.slice(-3)).toEqual([`${ORIGIN}/otel/v1/traces`, `${ORIGIN}/otel/v1/logs`, `${ORIGIN}/otel/v1/metrics`]);
    expect(session).toMatchObject({ status: 'authenticated', user: { sub: 'user-1', name: 'Ada' }, workspace: ACME });
    expect(getSession()).toBe(session);
    expect(w.page.url.href).toBe(`${ORIGIN}/t/acme/tenders?tab=open`);
    const [exchange] = w.kc.requests;
    expect(exchange?.grant).toBe('authorization_code');
    expect(exchange?.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.page.storedValues()).not.toMatch(/at-|eyJ|refresh/);
  });

  it('an ApiClient GET carries the Bearer token, x-request-id, traceparent and the session id', async () => {
    await w.signIn();
    const res = await createApiClient().get<{ title: string }>('/tenders/:id', { params: { id: '1' } });

    expect(res.data.title).toBe('Road works');
    const [req] = w.net.sent('/api/tenders/1');
    expect(req!.headers.get('authorization')).toBe(`Bearer ${await w.idp.getAccessToken()}`);
    expect(req!.headers.get('x-request-id')).toBe(res.requestId);
    expect(req!.headers.get('traceparent')).toMatch(TRACEPARENT);
    expect(req!.headers.get('x-session-id')).toBe(getSessionId());
    expect(res.headers.get('x-request-id')).toBe(res.requestId);

    // The client span is exported with the trace id the request carried.
    await unloadTelemetry();
    const [, traceId] = TRACEPARENT.exec(req!.headers.get('traceparent')!)!;
    expect(w.collector.spans.find((s) => s.name === 'HTTP GET')?.spanContext().traceId).toBe(traceId);
  });

  it('sends the token, request id and trace context to the page origin only', async () => {
    await w.signIn();
    const partner = createApiClient({ baseUrl: 'https://partner.example.com/v1' });
    await expect(partner.get('/tenders', { retry: false })).rejects.toThrow(); // no network there

    const [req] = w.net.requests.filter((r) => r.url.startsWith('https://partner.example.com/'));
    for (const h of ['authorization', 'x-request-id', 'traceparent', 'x-session-id']) expect(req!.headers.get(h), h).toBeNull();
  });

  it('a log inside withSpan carries its trace_id and span_id; the call made in it, the same trace and the logged request_id', async () => {
    await w.signIn();
    const api = createApiClient();
    const ids = await withSpan('save tender', async (span) => {
      const saved = api.post<{ id: string }>('/tenders', { body: { title: 'Bridge' } });
      getLogger().info('saving tender'); // the span is active until the first await
      const res = await saved;
      getLogger().info('tender saved', { request_id: res.requestId, tender: res.data.id });
      return { traceId: span.traceId, spanId: span.spanId, requestId: res.requestId };
    });
    await unloadTelemetry();

    const [req] = w.net.sent('/api/tenders');
    const [, traceId, parentId] = TRACEPARENT.exec(req!.headers.get('traceparent')!)!;
    expect(traceId).toBe(ids.traceId);
    expect(req!.headers.get('x-request-id')).toBe(ids.requestId);
    const client = w.collector.spans.find((s) => s.name === 'HTTP POST')!;
    expect(client.parentSpanContext?.spanId).toBe(ids.spanId);
    expect(client.spanContext().spanId).toBe(parentId);

    const logs = w.collector.logs.filter((l) => l.body.startsWith('saving') || l.body.startsWith('tender saved'));
    expect(logs.map((l) => l.attributes)).toEqual([
      { trace_id: ids.traceId, span_id: ids.spanId, session_id: getSessionId(), mfe: 'shell', page_route: 'unknown' },
      // After the await no span is active (the browser has no async context): request_id is the join key.
      { tender: '2', request_id: ids.requestId, session_id: getSessionId(), mfe: 'shell', page_route: 'unknown' },
    ]);
  });

  // Regression: the GET path awaits the token (for its dedupe key) before starting the request span;
  // bindTraceContext keeps the caller's span as its parent across that await.
  it('a GET started inside withSpan continues the span’s trace', async () => {
    await w.signIn();
    const traceId = await withSpan('open tender', async (span) => {
      await createApiClient().get('/tenders/:id', { params: { id: '1' } });
      return span.traceId;
    });
    const [req] = w.net.sent('/api/tenders/1');
    expect(TRACEPARENT.exec(req!.headers.get('traceparent')!)![1]).toBe(traceId);
  });
});
