// The reference Collector configuration for the browser's telemetry (examples/collector), both tiers in
// the real Collector image (the one docker-compose.yml pins), as deployed: two gateways behind /otel and
// two aggregators that share one DNS name (a headless service), each tier's exporters replaced by files
// (gateway.override.yaml, aggregator.override.yaml). What the SDK sends goes in over OTLP/HTTP; what the
// Collectors would hand to Mimir, Tempo and Loki comes out. Needs Docker: `pnpm test-collector` (CI job
// `collector`).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import { AggregationTemporality, InMemoryMetricExporter, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeCore, setConsentProvider } from '../../packages/frontend-sdk/src/core/index.ts';
import { resetRuntimeForTests } from '../../packages/frontend-sdk/src/internal/runtime.ts';
import { getServiceMeter, initializeMetrics } from '../../packages/frontend-sdk/src/metrics/index.ts';
import { setMetricsInternalsForTests, shutdownMetrics } from '../../packages/frontend-sdk/src/metrics/metrics.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = /otel-collector:\n\s+image: (\S+)/.exec(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'))![1]!;
const ENVIRONMENT = 'prod';
const SECOND = 1_000_000_000n;
const RUN = `collector-test-${randomBytes(4).toString('hex')}`;

interface Node {
  container: string;
  out: string;
  /** Host URL of its OTLP/HTTP receiver (gateways only). */
  url: string;
}
const gateways: Node[] = [];
const aggregators: Node[] = [];
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

function start(tier: 'gateway' | 'aggregator', i: number, extra: string[]): Node {
  const out = mkdtempSync(join(tmpdir(), `${tier}-`));
  chmodSync(out, 0o777); // the Collector runs as uid 10001
  const container = docker(
    'run', '-d', '--rm', '--name', `${RUN}-${tier}-${i}`, '--network', RUN, ...extra,
    '-p', '127.0.0.1::13133',
    '-v', `${join(ROOT, `examples/collector/${tier}.yaml`)}:/etc/otelcol/reference.yaml:ro`,
    '-v', `${join(import.meta.dirname, `${tier}.override.yaml`)}:/etc/otelcol/override.yaml:ro`,
    '-v', `${out}:/out`,
    IMAGE, '--config=/etc/otelcol/reference.yaml', '--config=/etc/otelcol/override.yaml',
  );
  const port = (p: number) => docker('port', container, `${p}/tcp`).split('\n')[0]!.split(':').pop();
  return { container, out, url: tier === 'gateway' ? `http://127.0.0.1:${port(4318)}` : '' };
}

async function healthy(node: Node): Promise<void> {
  const port = docker('port', node.container, '13133/tcp').split('\n')[0]!.split(':').pop();
  for (let i = 0; ; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined))?.ok) return;
    if (i > 150) throw new Error(`${node.container} did not start:\n${docker('logs', node.container)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  docker('network', 'create', RUN);
  for (const i of [1, 2]) {
    aggregators.push(start('aggregator', i, ['--network-alias', 'aggregator', '-e', 'METRICS_REMOTE_WRITE_URL=http://mimir.invalid/api/v1/push']));
  }
  for (const n of aggregators) await healthy(n);
  for (const i of [1, 2]) {
    gateways.push(start('gateway', i, [
      '-p', '127.0.0.1::4318',
      '-e', `PLATFORM_ENVIRONMENT=${ENVIRONMENT}`,
      '-e', 'TRACES_OTLP_ENDPOINT=http://tempo.invalid:4318',
      '-e', 'LOGS_OTLP_ENDPOINT=http://loki.invalid:3100/otlp',
      '-e', 'AGGREGATOR_HOSTNAME=aggregator',
      '-e', 'AGGREGATOR_TLS_INSECURE=true',
    ]));
  }
  for (const n of gateways) await healthy(n);
  // The gateways' DNS resolver has found both aggregators once points reach each.
  for (let i = 0; !aggregators.every((a) => lines(a, 'metrics').length > 0); i++) {
    if (i > 100) throw new Error(`the gateways never reached both aggregators:\n${docker('logs', gateways[0]!.container)}`);
    await post('metrics', delta('portal_web_app_warmup_total', tab('w'), 1, -1, 0, { ...LABELS, kind: `w${i}` }), i);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 180_000);

afterAll(() => {
  for (const n of [...gateways, ...aggregators]) {
    execFileSync('docker', ['rm', '-f', n.container], { stdio: 'ignore' });
    rmSync(n.out, { recursive: true, force: true });
  }
  execFileSync('docker', ['network', 'rm', RUN], { stdio: 'ignore' });
});

// ── OTLP JSON in and out ───────────────────────────────────────────────────────────────────────

type Attrs = Record<string, string>;
interface KeyValue {
  key: string;
  value: { stringValue?: string };
}
const kv = (a: Attrs): KeyValue[] => Object.entries(a).map(([key, v]) => ({ key, value: { stringValue: v } }));
const flat = (a: KeyValue[] | undefined): Attrs => Object.fromEntries((a ?? []).map((x) => [x.key, x.value.stringValue ?? '']));

/** A browser tab's resource: what the SDK sets, plus per-browser attributes an instrumentation or a forger adds. */
function tab(id: string): Attrs {
  return {
    'service.name': 'web-app',
    'service.namespace': 'portal',
    'deployment.environment.name': ENVIRONMENT,
    'service.instance.id': id,
    'browser.brands': 'Chromium 156',
    'user_agent.original': 'Mozilla/5.0',
  };
}
const LABELS: Attrs = { domain: 'portal', service: 'web_app', environment: ENVIRONMENT };

/** One delta counter point, as a tab's SDK exports it, with that device's own clock. */
function delta(name: string, resource: Attrs, value: number, startS: number, endS: number, labels: Attrs = LABELS) {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    resourceMetrics: [{
      resource: { attributes: kv(resource) },
      scopeMetrics: [{
        scope: { name: '@bcbp-solutions-fzc-llc/frontend-sdk' },
        metrics: [{
          name,
          sum: {
            aggregationTemporality: 1, // delta
            isMonotonic: true,
            dataPoints: [{ startTimeUnixNano: String(now + BigInt(startS) * SECOND), timeUnixNano: String(now + BigInt(endS) * SECOND), asInt: String(value), attributes: kv(labels) }],
          },
        }],
      }],
    }],
  };
}

/** POSTs to gateway `gw` (requests from one page reach any gateway replica). */
async function post(signal: 'metrics' | 'traces' | 'logs', body: unknown, gw = 0): Promise<void> {
  const res = await fetch(`${gateways[gw % gateways.length]!.url}/otel/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  expect(res.status, await res.text()).toBe(200);
  await new Promise((r) => setTimeout(r, 20)); // one request at a time, as tabs' requests arrive
}

/** A node's output so far; a line the Collector is still writing is left for the next read. */
function lines(node: Node, signal: string): Record<string, unknown>[] {
  const file = join(node.out, `${signal}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

interface OutPoint {
  aggregator: number;
  resource: Attrs;
  temporality: number;
  value: number;
  start: bigint;
  labels: Attrs;
}
type MetricsBody = { resourceMetrics: { resource: { attributes?: KeyValue[] }; scopeMetrics: { metrics: { name: string; sum?: { aggregationTemporality: number; dataPoints: { asInt?: string; asDouble?: number; startTimeUnixNano: string; attributes?: KeyValue[] }[] }; histogram?: { aggregationTemporality: number; dataPoints: { count: string; sum: number }[] } }[] }[] }[] };

/** Both aggregators' output points of metric `name`, in order per aggregator. */
function metricPoints(name: string): OutPoint[] {
  return aggregators.flatMap((node, aggregator) =>
    (lines(node, 'metrics') as unknown as MetricsBody[]).flatMap((b) =>
      b.resourceMetrics.flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) =>
          sm.metrics
            .filter((m) => m.name === name)
            .flatMap((m) =>
              (m.sum?.dataPoints ?? []).map((p) => ({
                aggregator,
                resource: flat(rm.resource.attributes),
                temporality: m.sum!.aggregationTemporality,
                value: Number(p.asInt ?? p.asDouble),
                start: BigInt(p.startTimeUnixNano),
                labels: flat(p.attributes),
              })),
            ),
        ),
      ),
    ),
  );
}

async function eventually<T>(fn: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Waits until `name` has `n` output points (the batch timeouts are 200 ms), and a little longer for strays. */
async function settled(name: string, n: number): Promise<OutPoint[]> {
  await eventually(() => (metricPoints(name).length >= n ? true : undefined), `${n} points of ${name}`);
  await new Promise((r) => setTimeout(r, 700));
  return metricPoints(name);
}

// ── Metrics ────────────────────────────────────────────────────────────────────────────────────

describe('metrics: delta → cumulative, one series for every tab', () => {
  it('sums every tab into one cumulative series, whatever each device clock says and whichever gateway it reached', async () => {
    const name = 'portal_web_app_clicks_total';
    // Each tab exports every 60 s on its own phase and clock. In arrival order, over both gateways:
    await post('metrics', delta(name, tab('a'), 5, -60, -40), 0); // a: on time
    await post('metrics', delta(name, tab('b'), 4, -58, -48), 1); // b: its interval ended before a's (late beacon)
    await post('metrics', delta(name, tab('c'), 2, -3660, -3600), 0); // c: device clock an hour slow
    await post('metrics', delta(name, tab('d'), 3, 600, 660), 1); // d: device clock 10 minutes fast
    await post('metrics', delta(name, tab('e'), 7, 0, 0), 0); // e: a zero-length interval
    await post('metrics', delta(name, tab('a'), 1, -40, -30), 1); // a again

    const points = await settled(name, 6);
    // Nothing dropped: without the re-stamping (aggregator transform/receive-time), delta_to_cumulative
    // silently dropped b and d (a late beacon, a fast clock), and the sum was 15. The two gateways batch
    // independently, so the aggregator may see the deltas in another order; each is added exactly once.
    const values = points.map((p) => p.value);
    expect(values.at(-1)).toBe(22);
    expect(values.map((v, i) => v - (values[i - 1] ?? 0)).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(new Set(points.map((p) => p.aggregator)).size).toBe(1); // one aggregator holds the stream
    expect(new Set(points.map((p) => p.temporality))).toEqual(new Set([2])); // cumulative
    expect(new Set(points.map((p) => p.start)).size).toBe(1); // one series, one start
    expect(points.map((p) => p.labels)).toEqual(points.map(() => LABELS));
  });

  it('routes each stream to one aggregator, so no two Collectors write different totals for one series', async () => {
    const name = 'portal_web_app_routed_total';
    const STREAMS = 24;
    for (let round = 1; round <= 3; round++) {
      for (let s = 0; s < STREAMS; s++) await post('metrics', delta(name, tab(`t${round}`), round, -1, 0, { ...LABELS, kind: `k${s}` }), s + round);
    }
    const points = await settled(name, STREAMS * 3);
    const byStream = new Map<string, OutPoint[]>();
    for (const p of points) byStream.set(p.labels.kind!, [...(byStream.get(p.labels.kind!) ?? []), p]);
    expect(byStream.size).toBe(STREAMS);
    for (const [kind, ps] of byStream) {
      expect(new Set(ps.map((p) => p.aggregator)).size, kind).toBe(1);
      expect(ps.map((p) => p.value), kind).toEqual([1, 3, 6]);
    }
    expect(new Set(points.map((p) => p.aggregator))).toEqual(new Set([0, 1])); // both aggregators share the load
  });

  it('drops per-browser resource attributes, keeps the service identity', async () => {
    const [p] = await settled('portal_web_app_clicks_total', 6);
    expect(p!.resource).toEqual({ 'service.name': 'web-app', 'service.namespace': 'portal', 'deployment.environment.name': ENVIRONMENT });
  });

  it('allowlists label values: the platform vocabulary, the registered domains, this environment', async () => {
    const name = 'platform_web_vital_ratings_total';
    const ok = { ...LABELS, vital: 'lcp', rating: 'good', page_route: '/t/:tenant/tenders', mfe: 'tenders' };
    const rejected: Attrs[] = [
      { ...ok, rating: 'great' }, // rating outside the vocabulary
      { ...ok, vital: 'fid' }, // vital outside the vocabulary
      { ...ok, page_route: 'https://evil.example/?q=1' }, // a URL, not a route template
      { ...ok, mfe: 'Tenders' }, // mfe with upper case
      { ...ok, environment: 'dev' }, // another environment
      { ...ok, domain: 'acme' }, // a domain the registry does not know
      { service: 'web_app', environment: ENVIRONMENT }, // no domain
      { ...ok, service: 'web app' }, // service with a space
    ];
    for (const labels of rejected) await post('metrics', delta(name, tab('x'), 1, -1, 0, labels));
    await post('metrics', delta(name, tab('x'), 1, -1, 0, ok));
    const points = await settled(name, 1);
    expect(points.map((p) => p.labels)).toEqual([ok]);
  });

  it('allowlists metric names: platform_web_* or a registered <domain>_* matching the domain label, with a unit suffix', async () => {
    const minted: [string, Attrs][] = [
      ['evil_bomb_1_total', LABELS], // no registered domain
      ['acme_web_app_clicks_total', { ...LABELS, domain: 'acme' }], // an unregistered domain, consistently labelled
      ['iam_web_app_clicks_total', LABELS], // a registered domain other than its domain label
      ['portal_web_app_clicks', LABELS], // no unit suffix
      ['Portal-Bad-Name', LABELS], // not a metric name
      ['platform_other_clicks_total', LABELS], // platform_* outside the browser's platform_web_*
    ];
    for (const [name, labels] of minted) await post('metrics', delta(name, tab('x'), 1, -1, 0, labels));
    await post('metrics', delta('tender_management_web_app_saves_total', tab('x'), 1, -1, 0, { ...LABELS, domain: 'tender_management' }));
    await settled('tender_management_web_app_saves_total', 1);
    for (const [name] of minted) expect(metricPoints(name), name).toEqual([]);
  });

  it('cuts any label value at 128 characters (a Tier 3 label with a runaway value)', async () => {
    const name = 'portal_web_app_searches_total';
    await post('metrics', delta(name, tab('x'), 1, -1, 0, { ...LABELS, outcome: 'x'.repeat(1000) }));
    const [p] = await settled(name, 1);
    expect(p!.labels.outcome).toBe('x'.repeat(128));
  });

  it('takes what the SDK itself serializes (delta counter and histogram, const labels injected)', async () => {
    resetRuntimeForTests();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    setMetricsInternalsForTests({ exporter: () => exporter as PushMetricExporter });
    initializeCore({ serviceName: 'web_app', domain: 'portal', environment: ENVIRONMENT, buildVersion: '1.0.0' });
    setConsentProvider({ has: () => true, subscribe: () => () => {} });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().counter('portal_web_app_saves_total', 'Saves.', ['kind']).add(2, { kind: 'draft' });
    getServiceMeter().histogram('portal_web_app_render_seconds', 'Render.', []).record(0.25);
    await shutdownMetrics();
    for (const rm of exporter.getMetrics()) await post('metrics', new TextDecoder().decode(JsonMetricsSerializer.serializeRequest(rm)!));
    resetRuntimeForTests();

    const [saves] = await settled('portal_web_app_saves_total', 1);
    expect(saves).toMatchObject({ value: 2, temporality: 2, labels: { ...LABELS, kind: 'draft' } });
    const histogram = await eventually(
      () => aggregators.flatMap((a) => (lines(a, 'metrics') as unknown as MetricsBody[]).flatMap((b) => b.resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics)))).find((m) => m.name === 'portal_web_app_render_seconds')?.histogram,
      'the histogram',
    );
    expect(histogram.aggregationTemporality).toBe(2);
    expect(histogram.dataPoints[0]).toMatchObject({ count: '1', sum: 0.25 });
  });
});

// ── Traces and logs ──────────────────────────────────────────────────────────────────────────

describe('traces and logs', () => {
  it('pass through the gateway on /otel/v1/*, without per-browser resource attributes', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    await post('traces', {
      resourceSpans: [{ resource: { attributes: kv(tab('t')) }, scopeSpans: [{ scope: { name: 'sdk' }, spans: [{ traceId, spanId: 'b7ad6b7169203331', name: 'GET /api/tenders', kind: 3, startTimeUnixNano: '1', endTimeUnixNano: '2' }] }] }],
    });
    await post('logs', {
      resourceLogs: [{ resource: { attributes: kv(tab('t')) }, scopeLogs: [{ scope: { name: 'sdk' }, logRecords: [{ timeUnixNano: '1', severityNumber: 17, severityText: 'ERROR', body: { stringValue: 'collector-test log' }, attributes: kv({ detail: 'y'.repeat(5000) }) }] }] }],
    });
    type Res = { resource: { attributes?: KeyValue[] } };
    const gw = gateways[0]!;
    const span = await eventually(() => (lines(gw, 'traces') as { resourceSpans: (Res & { scopeSpans: { spans: { traceId: string }[] }[] })[] }[]).flatMap((b) => b.resourceSpans).find((rs) => rs.scopeSpans.some((ss) => ss.spans.some((s) => s.traceId === traceId))), 'the span');
    expect(flat(span.resource.attributes)).toEqual({ 'service.name': 'web-app', 'service.namespace': 'portal', 'deployment.environment.name': ENVIRONMENT });
    type LogBody = { resourceLogs: (Res & { scopeLogs: { logRecords: { body: { stringValue: string }; attributes?: KeyValue[] }[] }[] })[] };
    const logs = await eventually(() => (lines(gw, 'logs') as unknown as LogBody[]).flatMap((b) => b.resourceLogs).find((rl) => rl.scopeLogs.some((sl) => sl.logRecords.some((r) => r.body.stringValue === 'collector-test log'))), 'the log');
    expect(flat(logs.resource.attributes)).not.toHaveProperty('service.instance.id');
    expect(flat(logs.resource.attributes)).not.toHaveProperty('user_agent.original');
    expect(flat(logs.scopeLogs[0]!.logRecords[0]!.attributes).detail).toHaveLength(4096);
  });
});
