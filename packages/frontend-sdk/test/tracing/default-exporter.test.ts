// Runs in its own module graph, so initializeTracing builds the production OTLP exporter (the other
// tracing tests replace it). Telemetry consent is never granted here, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeCore, setConsentProvider } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { getTracer, initializeTracing, shutdownTracing } from '../../src/tracing/index.ts';
import { tracingStats } from '../../src/tracing/tracing.ts';

beforeEach(() => {
  resetRuntimeForTests();
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod', buildVersion: '1.0.0' });
  setConsentProvider({ has: () => false, subscribe: () => () => {} });
});

afterEach(async () => {
  await shutdownTracing();
});

describe('the production OTLP span exporter', () => {
  it('receives no span without telemetry consent, and shuts down cleanly', async () => {
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    getTracer('t').startSpan('a').end();
    getTracer('t').startSpan('b').end();
    const stats = tracingStats()!;
    await expect(shutdownTracing()).resolves.toBeUndefined();
    expect(stats).toEqual({ exported: 0, droppedQueueFull: 0, droppedNoConsent: 2, droppedOnUnload: 0, exportFailures: 0 });
  });
});
