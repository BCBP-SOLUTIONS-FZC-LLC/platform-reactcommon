// Runs in its own module graph, so initializeLogging builds the production OTLP exporter (the other
// logging tests replace it). Telemetry consent is never granted and only consent-gated levels are
// used here, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeCore, setConsentProvider } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { getLogger, initializeLogging } from '../../src/logging/index.ts';
import { loggingStats, shutdownLogging } from '../../src/logging/logging.ts';

beforeEach(() => {
  resetRuntimeForTests();
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'prod', buildVersion: '1.0.0' });
  setConsentProvider({ has: () => false, subscribe: () => () => {} });
});

afterEach(async () => {
  await shutdownLogging();
});

describe('the production OTLP log exporter', () => {
  it('receives nothing without telemetry consent, and shuts down cleanly', async () => {
    initializeLogging({ otlpBaseUrl: '/otel', level: 'debug' });
    getLogger().debug('d');
    getLogger().info('i');
    getLogger().warn('w');
    const stats = loggingStats()!;
    await expect(shutdownLogging()).resolves.toBeUndefined();
    expect(stats).toEqual({ exported: 0, droppedQueueFull: 0, exportFailures: 0, beacons: 0, droppedNoConsent: 3 });
  });
});
