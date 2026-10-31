// Consent and the runtime config's off switch across all three signals at once: what leaves the page
// is what the in-memory collector receives through the exporter seams.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionId } from '../../packages/frontend-sdk/src/core/index.ts';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { getLogger } from '../../packages/frontend-sdk/src/logging/index.ts';
import { getServiceMeter } from '../../packages/frontend-sdk/src/metrics/index.ts';
import { metricsState, metricsStats } from '../../packages/frontend-sdk/src/metrics/metrics.ts';
import { withSpan } from '../../packages/frontend-sdk/src/tracing/index.ts';
import { World, consentManager, endWorld, runtimeConfigJson, useFakeClock } from '../fixtures/boot.ts';
import { settled, unloadTelemetry } from '../fixtures/telemetry.ts';

const CLICKS = 'portal_web_app_clicks_total';

/** One of everything a page emits: a span, a log at every level (one essential warn), a metric point. */
async function emitAll(tag: string): Promise<void> {
  const log = getLogger();
  await withSpan(`work ${tag}`, () => {
    log.debug(`debug ${tag}`);
    log.info(`info ${tag}`);
    log.warn(`warn ${tag}`);
    log.warn(`essential warn ${tag}`, { essential: true });
    log.error(`error ${tag}`, { error: new Error('boom') });
  });
  getServiceMeter().counter(CLICKS, 'Clicks.', ['tag']).add(1, { tag });
}

/** The metrics reader's export interval, now. */
const exportMetrics = () => settled(metricsState().provider!.forceFlush());

beforeEach(() => useFakeClock());
afterEach(endWorld);

describe('consent', () => {
  it('without telemetry consent only errors and essential warnings leave; accepting starts every signal', async () => {
    const w = new World('/');
    w.consent = consentManager(); // essential only, as the shell's CMP starts
    await w.load();

    await emitAll('before');
    await exportMetrics();
    expect(w.collector.spans).toEqual([]);
    expect(w.collector.logs.map((l) => l.body)).toEqual([]); // not flushed yet: the queue holds what may go
    expect(w.collector.points()).toEqual([]);
    expect(metricsStats().droppedNoConsent).toBe(1);

    w.consent.accept(['telemetry']);
    await emitAll('after');
    await unloadTelemetry();

    expect(w.collector.spans.map((s) => s.name)).toEqual(['work after']);
    expect(w.collector.logs.map((l) => l.body)).toEqual([
      'essential warn before',
      'error before',
      'debug after',
      'info after',
      'warn after',
      'essential warn after',
      'error after',
    ]);
    // The essential flag is a routing hint: it is never sent itself.
    expect(w.collector.logs[0]!.attributes).not.toHaveProperty('essential');
    expect(w.collector.points(CLICKS)).toEqual([
      { name: CLICKS, attributes: { tag: 'after', domain: 'portal', service: 'web-app', environment: 'test' }, value: 1 },
    ]);
  });

  it('an error logged without consent still carries its trace and session correlation', async () => {
    const w = new World('/');
    w.consent = consentManager();
    await w.load();
    const ids = await withSpan('save', (s) => {
      getLogger().error('save failed', { error: new TypeError('bad') });
      return { traceId: s.traceId, spanId: s.spanId };
    });
    await unloadTelemetry();
    expect(w.collector.spans).toEqual([]); // the span itself needs consent
    expect(w.collector.logs).toEqual([
      {
        level: 'error',
        body: 'save failed',
        attributes: expect.objectContaining({ 'exception.type': 'TypeError', trace_id: ids.traceId, span_id: ids.spanId, session_id: getSessionId() }),
      },
    ]);
  });
});

describe('telemetry.enabled = false', () => {
  it('exports nothing from any signal, errors included, and sends no trace context', async () => {
    const w = new World('/t/acme/', runtimeConfigJson({ telemetry: { enabled: false } }));
    w.net.on('GET /api/tenders', Response.json([]));
    await w.signIn();

    await emitAll('off');
    await createApiClient().get('/tenders');
    await unloadTelemetry();

    expect(w.collector.urls).toEqual([]); // no exporter was ever created
    expect(w.collector.exported).toBe(0);
    expect(w.net.requests.filter((r) => new URL(r.url).pathname.startsWith('/otel'))).toEqual([]);
    const [req] = w.net.sent('/api/tenders');
    expect(req!.headers.get('traceparent')).toBeNull();
    expect(req!.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/); // correlation by request id still works
    expect(req!.headers.get('authorization')).toMatch(/^Bearer at-/);
  });
});
