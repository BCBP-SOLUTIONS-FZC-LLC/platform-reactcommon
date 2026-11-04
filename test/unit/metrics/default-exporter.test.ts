// Runs in its own module graph, so initializeMetrics builds the production OTLP exporter (the other
// metrics tests replace it). Telemetry consent is never granted here, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeCore, setConsentProvider } from '../../../packages/frontend-sdk/src/core/index.ts';
import { resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { getServiceMeter, initializeMetrics } from '../../../packages/frontend-sdk/src/metrics/index.ts';
import { metricsState, metricsStats, shutdownMetrics } from '../../../packages/frontend-sdk/src/metrics/metrics.ts';

beforeEach(() => {
  resetRuntimeForTests();
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod', buildVersion: '1.0.0' });
  setConsentProvider({ has: () => false, subscribe: () => () => {} });
});

afterEach(async () => {
  await shutdownMetrics();
});

describe('the production OTLP metric exporter', () => {
  it('is gated on telemetry consent: every interval is discarded and counted, and shutdown is clean', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const saves = getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', []);
    saves.add(1);
    await metricsState().provider!.forceFlush();
    saves.add(1);
    await metricsState().provider!.forceFlush();
    expect(metricsStats().droppedNoConsent).toBe(2);
    await expect(shutdownMetrics()).resolves.toBeUndefined();
    expect(metricsState().provider).toBeUndefined();
  });
});

describe('shutdownMetrics (review 3)', () => {
  it('collects and sends the last interval: what was recorded since the last export is not lost', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const saves = getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', []);
    saves.add(1);
    await metricsState().provider!.forceFlush();
    saves.add(1); // after the last export, before shutdown
    await shutdownMetrics();
    expect(metricsStats().droppedNoConsent).toBe(2); // the second interval reached the (consent-gated) exporter
  });
});
