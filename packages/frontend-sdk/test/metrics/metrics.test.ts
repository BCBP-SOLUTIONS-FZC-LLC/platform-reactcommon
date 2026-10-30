import { AggregationTemporality, InMemoryMetricExporter, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCore, setConsentProvider, type ConsentCategory } from '../../src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { METRIC_REGISTRY } from '../../src/internal/generated/metric-registry.ts';
import { servicePrefix, suffixProblem } from '../../src/metrics/checks.ts';
import { InvalidMetricError, getDomainMeter, getServiceMeter, initializeMetrics, startWebVitals } from '../../src/metrics/index.ts';
import { renderMetricInventory } from '../../src/metrics/inventory.ts';
import { metricsState, metricsStats, setMetricsInternalsForTests, shutdownMetrics } from '../../src/metrics/metrics.ts';
import { PARITY_CASES, sdkVerdict } from './parity-cases.ts';

let exporter: InMemoryMetricExporter;
let exportedUrl: string | undefined;
const consent = (granted: ConsentCategory[]) => setConsentProvider({ has: (c) => granted.includes(c), subscribe: () => () => {} });
const core = (domain = 'tender_management') => initializeCore({ serviceName: 'web-app', domain, environment: 'dev', buildVersion: '1.0.0' });

/** Exported data points of `name`, after a flush. */
async function points(name: string) {
  await shutdownMetrics();
  return exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value, unit: m.descriptor.unit, temporality: m.aggregationTemporality })));
}

beforeEach(() => {
  resetRuntimeForTests();
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  exportedUrl = undefined;
  setMetricsInternalsForTests({
    exporter: (url) => {
      exportedUrl = url;
      return exporter as PushMetricExporter;
    },
  });
  core();
  consent(['telemetry']);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await shutdownMetrics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The InvalidMetricError rule `f` throws, or 'ok'. */
function ruleOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidMetricError);
    return (e as InvalidMetricError).rule;
  }
  return 'ok';
}

describe('parity cases (also run against metricslint by scripts/metrics-parity.ts)', () => {
  it.each(PARITY_CASES.map((c) => [`${c.tier}: ${c.name}`, c] as const))('%s', (_, c) => {
    expect(sdkVerdict(c)).toBe(c.sdk);
  });
});

describe('rules', () => {
  it('builds the service prefix like gincommon ServicePrefix', () => {
    expect(servicePrefix('tender_management', 'web-app')).toBe('tender_management_web_app_');
    expect(servicePrefix('iam', 'iam-admin')).toBe('iam_admin_');
    expect(servicePrefix('iam', '--Odd..Name--')).toBe('iam_odd_name_');
  });

  it('checks suffixes like gincommon suffixError', () => {
    expect(suffixProblem('counter', 'x_total')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_bytes', 'bytes')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_seconds', 'seconds')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_ms', 'milliseconds')).toContain('not supported');
  });
});

describe('initializeMetrics', () => {
  it('exports delta points with the injected identity labels to <otlpBaseUrl>/v1/metrics', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', ['kind']).add(2, { kind: 'draft' });
    const [p] = await points('tender_management_web_app_saves_total');
    expect(exportedUrl).toBe('http://localhost/otel/v1/metrics');
    expect(p).toEqual({
      attributes: { kind: 'draft', domain: 'tender_management', service: 'web-app', environment: 'dev' },
      value: 2,
      unit: '',
      temporality: AggregationTemporality.DELTA,
    });
  });

  it('starts recording instruments created before it', async () => {
    const c = getServiceMeter().counter('tender_management_web_app_early_total', 'Early.', []);
    c.add(1);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    c.add(5);
    expect((await points('tender_management_web_app_early_total')).map((p) => p.value)).toEqual([5]);
  });

  it('validates its options and needs initializeCore', () => {
    expect(() => initializeMetrics({ otlpBaseUrl: '/otel', exportIntervalMs: 10 })).toThrow(RangeError);
    expect(() => initializeMetrics({ otlpBaseUrl: 'https://collector.example' })).toThrow(TypeError);
    resetRuntimeForTests();
    expect(() => initializeMetrics({ otlpBaseUrl: '/otel' })).toThrow('initializeCore');
  });

  it('exports nothing without telemetry consent', async () => {
    consent([]);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', []).add(1);
    expect(await points('tender_management_web_app_saves_total')).toEqual([]);
    expect(metricsStats().droppedNoConsent).toBeGreaterThan(0);
  });

  it('is a no-op the second time', () => {
    let made = 0;
    setMetricsInternalsForTests({
      exporter: (url) => {
        made++;
        exportedUrl = url;
        return exporter as PushMetricExporter;
      },
    });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const provider = metricsState().provider;
    initializeMetrics({ otlpBaseUrl: '/other', exportIntervalMs: 5_000 });
    expect(made).toBe(1);
    expect(exportedUrl).toBe('http://localhost/otel/v1/metrics');
    expect(metricsState().provider).toBe(provider);
  });

  it('flushes on pagehide and when the page is hidden, and stops listening after shutdown', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    initializeMetrics({ otlpBaseUrl: '/otel' }); // 60 s interval: only a page event exports in this test
    const flush = vi.spyOn(metricsState().provider!, 'forceFlush');
    getServiceMeter().counter('tender_management_web_app_hides_total', 'Hides.', []).add(3);

    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flush).not.toHaveBeenCalled(); // still visible
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exporter.getMetrics().length).toBeGreaterThan(0));
    win.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);

    await shutdownMetrics();
    win.dispatchEvent(new Event('pagehide'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(2);
    const exported = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((m) => m.descriptor.name === 'tender_management_web_app_hides_total')
      .flatMap((m) => m.dataPoints.map((p) => p.value));
    expect(exported).toEqual([3]); // delta: later flushes carry no new points
  });

  it('survives a throwing exporter: flushes, page-hide flushes and shutdown never throw', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    let attempts = 0;
    setMetricsInternalsForTests({
      exporter: () => ({
        export: () => {
          attempts++;
          throw new Error('collector down');
        },
        forceFlush: async () => {},
        shutdown: async () => {},
      }),
    });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const c = getServiceMeter().counter('tender_management_web_app_lost_total', 'Lost.', []);
    c.add(1);
    await expect(metricsState().provider!.forceFlush()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    c.add(1);
    win.dispatchEvent(new Event('pagehide')); // the failed flush is swallowed, not an unhandled rejection
    await vi.waitFor(() => expect(attempts).toBe(2));
    c.add(1);
    await expect(shutdownMetrics()).resolves.toBeUndefined();
    expect(metricsState().provider).toBeUndefined();
    expect(metricsStats().droppedNoConsent).toBe(0);
  });

  it('records histograms in seconds with the request_duration preset by default', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().histogram('tender_management_web_app_render_seconds', 'Render.', []).record(0.3);
    const [p] = await points('tender_management_web_app_render_seconds');
    expect(p!.unit).toBe('s');
    expect((p!.value as { count: number }).count).toBe(1);
  });
});

describe('meters', () => {
  it('throw InvalidMetricError with the rule at registration', () => {
    const m = getServiceMeter();
    const rule = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidMetricError);
        return (e as InvalidMetricError).rule;
      }
      return 'ok';
    };
    expect(rule(() => m.counter('tender_management_web_app_x', 'X.', []))).toBe('suffix');
    expect(rule(() => m.counter('tender_management_web_app_x_total', ' ', []))).toBe('registry');
    expect(rule(() => m.counter('tender_management_web_app_x_total', 'X.', ['service']))).toBe('required_labels');
    expect(rule(() => m.histogram('tender_management_web_app_x_seconds', 'X.', [], [1, 0.5]))).toBe('registry');
    expect(rule(() => getDomainMeter().counter('iam_tenant_resolution_total'))).toBe('namespace');
  });

  it('reject domain metrics that are unknown, not domain-tier, of the other type, or duplicate labels', () => {
    expect(ruleOf(() => getDomainMeter().counter('tender_management_unknown_total'))).toBe('registry');
    expect(ruleOf(() => getDomainMeter().histogram('platform_http_request_duration_seconds'))).toBe('registry');
    expect(() => getDomainMeter().histogram('platform_http_request_duration_seconds')).toThrow('not a domain one');
    resetRuntimeForTests();
    core('iam');
    expect(() => getDomainMeter().counter('iam_lifecycle_event_lag_seconds')).toThrow('is a histogram, not a counter');
    expect(ruleOf(() => getDomainMeter().histogram('iam_lifecycle_event_lag_seconds'))).toBe('ok');
    expect(ruleOf(() => getServiceMeter().counter('iam_web_app_x_total', 'X.', ['kind', 'kind']))).toBe('label_vocabulary');
  });

  it("take a domain histogram's help, labels and buckets from its registry entry", async () => {
    resetRuntimeForTests();
    core('iam');
    consent(['telemetry']);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const h = getDomainMeter().histogram('iam_lifecycle_event_lag_seconds');
    h.record(2, { event_type: 'tenant.created' });
    h.record(1, { event_type: 'tenant.created', strategy: 'x' } as Record<string, string>); // undeclared: dropped
    await shutdownMetrics();
    const [m] = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((x) => x.descriptor.name === 'iam_lifecycle_event_lag_seconds');
    expect(m!.descriptor.description).toBe(METRIC_REGISTRY.metrics.find((x) => x.name === 'iam_lifecycle_event_lag_seconds')!.help);
    expect(m!.descriptor.unit).toBe('s');
    expect(m!.dataPoints).toHaveLength(1);
    const p = m!.dataPoints[0]!;
    expect(p.attributes).toEqual({ event_type: 'tenant.created', domain: 'iam', service: 'web-app', environment: 'dev' });
    expect((p.value as { buckets: { boundaries: number[] } }).buckets.boundaries).toEqual([0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 1800]);
    expect(metricsStats().droppedInvalid).toBe(1);
  });

  it('are idempotent for the same definition and reject a different one', () => {
    const a = getServiceMeter().counter('tender_management_web_app_x_total', 'X.', ['kind']);
    const b = getServiceMeter().counter('tender_management_web_app_x_total', 'X.', ['kind']);
    expect(a).not.toBe(b); // handles differ, the instrument is shared
    expect(() => getServiceMeter().counter('tender_management_web_app_x_total', 'Other help.', ['kind'])).toThrow('different definition');
  });

  it('give a remote its owning domain and name as identity', async () => {
    getRuntime().remotes = { 'tenders-editor': 'tender_management', 'iam-admin': 'iam' };
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter({ mfe: 'iam-admin' }).counter('iam_admin_clicks_total', 'Clicks.', []).add(1);
    getDomainMeter({ mfe: 'iam-admin' }).counter('iam_tenant_resolution_total').add(1, { strategy: 'slug', outcome: 'success' });
    expect((await points('iam_admin_clicks_total'))[0]!.attributes).toEqual({ domain: 'iam', service: 'iam-admin', environment: 'dev' });
    expect(() => getServiceMeter({ mfe: 'unknown-remote' })).not.toThrow();
    expect(() => getServiceMeter({ mfe: 'unknown-remote' }).counter('x_total', 'X.', [])).toThrow('remote manifest');
  });

  it('are no-ops without a page identity (a remote run standalone), but still check what they can', () => {
    resetRuntimeForTests();
    expect(() => getServiceMeter().counter('iam_admin_x_total', 'X.', []).add(1)).not.toThrow();
    expect(() => getDomainMeter().histogram('iam_lifecycle_event_lag_seconds').record(1, { event_type: 'tenant.created' })).not.toThrow();
    expect(renderMetricInventory()).toBe('');
    expect(metricsStats().droppedInvalid).toBe(0);
    // Rules that need no scope identity throw at creation all the same.
    expect(ruleOf(() => getServiceMeter().counter('anything', 'X.', []))).toBe('suffix');
    expect(ruleOf(() => getServiceMeter().counter('anything_total', ' ', []))).toBe('registry');
    expect(ruleOf(() => getServiceMeter().counter('anything_total', 'X.', ['user_id']))).toBe('prohibited_label');
    expect(ruleOf(() => getServiceMeter().histogram('anything_seconds', 'X.', [], [2, 1]))).toBe('registry');
    expect(ruleOf(() => getDomainMeter().histogram('anything'))).toBe('registry');
    expect(ruleOf(() => getDomainMeter().counter('iam_lifecycle_event_lag_seconds'))).toBe('registry');
  });

  it('created before initializeCore (module scope in shell code) record once it runs', async () => {
    resetRuntimeForTests();
    const early = getServiceMeter().counter('iam_web_app_boot_total', 'Boot.', ['kind']);
    const lag = getDomainMeter().histogram('iam_lifecycle_event_lag_seconds');
    early.add(7, { kind: 'before' }); // no identity yet: a no-op
    lag.record(7, { event_type: 'tenant.created' });
    core('iam');
    consent(['telemetry']);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    early.add(2, { kind: 'after' });
    lag.record(3, { event_type: 'tenant.created' });
    const identity = { domain: 'iam', service: 'web-app', environment: 'dev' };
    expect((await points('iam_web_app_boot_total')).map((p) => [p.value, p.attributes])).toEqual([[2, { kind: 'after', ...identity }]]);
    expect((await points('iam_lifecycle_event_lag_seconds')).map((p) => [(p.value as { sum: number }).sum, p.attributes])).toEqual([
      [3, { event_type: 'tenant.created', ...identity }],
    ]);
    expect(metricsStats().droppedInvalid).toBe(0);
  });

  it('created before initializeCore drop their points (counted, never thrown) when the identity does not fit them', () => {
    resetRuntimeForTests();
    const wrongPrefix = getServiceMeter().counter('iam_admin_x_total', 'X.', []);
    const wrongDomain = getDomainMeter().counter('iam_tenant_resolution_total');
    const remote = getServiceMeter({ mfe: 'iam-admin' }).counter('iam_admin_y_total', 'Y.', []);
    core();
    expect(() => wrongPrefix.add(1)).not.toThrow();
    expect(() => wrongDomain.add(1, { strategy: 'slug', outcome: 'success' })).not.toThrow();
    remote.add(1); // the manifest has not loaded yet
    expect(metricsStats().droppedInvalid).toBe(3);
    getRuntime().remotes = { 'iam-admin': 'iam' };
    remote.add(1); // retried: the remote now has its owning domain
    expect(metricsStats().droppedInvalid).toBe(3);
    expect(renderMetricInventory()).toMatch(/^iam_admin_y_total\{domain="iam",environment="dev",service="iam-admin"\} /m);
  });
});

describe('data points', () => {
  it('are dropped (never thrown) when they break a rule, and counted', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const c = getServiceMeter().counter('tender_management_web_app_jobs_total', 'Jobs.', ['outcome']);
    c.add(1, { outcome: 'maybe' }); // outside the registry vocabulary
    c.add(1, {}); // missing label
    c.add(1, { outcome: 'success', extra: 'x' }); // undeclared label
    c.add(1, { outcome: 'success', service: 'x' } as Record<string, string>); // injected label
    c.add(-1, { outcome: 'success' }); // negative
    c.add(Number.NaN, { outcome: 'success' });
    c.add(1, { outcome: 'success' });
    expect(metricsStats().droppedInvalid).toBe(6);
    expect((await points('tender_management_web_app_jobs_total')).map((p) => p.value)).toEqual([1]);
  });

  it("record page_route as 'unknown' unless the router registered it", async () => {
    getRuntime().routeTemplates.add('/tenders/:id');
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const h = getServiceMeter().counter('tender_management_web_app_views_total', 'Views.', ['page_route']);
    h.add(1, { page_route: '/tenders/:id' });
    h.add(1, { page_route: '/admin/secret' });
    const routes = (await points('tender_management_web_app_views_total')).map((p) => p.attributes.page_route).sort();
    expect(routes).toEqual(['/tenders/:id', 'unknown']);
    expect(metricsStats().labelOverflow).toBe(1);
  });

  it("cap a service label at 100 values, then record '__other__'", async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const c = getServiceMeter().counter('tender_management_web_app_tabs_total', 'Tabs.', ['tab']);
    for (let i = 0; i < 105; i++) c.add(1, { tab: `t${i}` });
    const values = new Set((await points('tender_management_web_app_tabs_total')).map((p) => p.attributes.tab));
    expect(values.size).toBe(101);
    expect(values.has('__other__')).toBe(true);
  });

  it('drop points past a registry label bound', () => {
    const c = getServiceMeter().counter('tender_management_web_app_strategies_total', 'S.', ['strategy']); // strategy: max_values 20
    for (let i = 0; i < 25; i++) c.add(1, { strategy: `s${i}` });
    expect(metricsStats().droppedInvalid).toBe(5);
  });

  it('accept the mfe label only for manifest remotes and the shell', () => {
    getRuntime().remotes = { tenders: 'tender_management' };
    const c = getServiceMeter().counter('tender_management_web_app_loads_total', 'Loads.', ['mfe']);
    c.add(1, { mfe: 'shell' });
    c.add(1, { mfe: 'tenders' });
    c.add(1, { mfe: 'evil' });
    expect(metricsStats().droppedInvalid).toBe(1);
  });

  it('warn once per metric and reason in dev', () => {
    const c = getServiceMeter().counter('tender_management_web_app_w_total', 'W.', []);
    c.add(-1);
    c.add(-2);
    expect(console.warn).toHaveBeenCalledTimes(2); // value differs, so two reasons
    c.add(-1);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe('renderMetricInventory', () => {
  it('renders every recorded label set with the injected labels, as Prometheus text', () => {
    const m = getServiceMeter();
    m.counter('tender_management_web_app_saves_total', 'Saves "quoted"\nhelp.', ['kind']).add(1, { kind: 'a"b' });
    m.histogram('tender_management_web_app_render_seconds', 'Render.', [], [0.1, 1]).record(0.5);
    expect(renderMetricInventory()).toBe(
      [
        '# HELP tender_management_web_app_render_seconds Render.',
        '# TYPE tender_management_web_app_render_seconds histogram',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="0.1"} 1',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="1"} 1',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="+Inf"} 1',
        'tender_management_web_app_render_seconds_sum{domain="tender_management",environment="dev",service="web-app"} 0',
        'tender_management_web_app_render_seconds_count{domain="tender_management",environment="dev",service="web-app"} 1',
        '# HELP tender_management_web_app_saves_total Saves "quoted"\\nhelp.',
        '# TYPE tender_management_web_app_saves_total counter',
        'tender_management_web_app_saves_total{domain="tender_management",environment="dev",kind="a\\"b",service="web-app"} 1',
        '',
      ].join('\n'),
    );
  });
});

describe('startWebVitals', () => {
  it('records nothing until the Tier 1 binding (design doc §D6 K)', () => {
    expect(() => startWebVitals()).not.toThrow();
    expect(renderMetricInventory()).toBe('');
  });
});
