// The shell's bootstrap (design doc §C4) without React, for the integration suites: one FakePage on
// a FakeNetwork with a FakeKeycloak, the SDK booted in the documented order, and a page load helper
// that starts the SDK afresh on the same tab (storage kept), as a reload or the login callback does.
import { vi } from 'vitest';
import { createOidcProvider, initializeAuth, type IdentityProvider, type SessionState, type Workspace, type WorkspaceResolver } from '../../packages/frontend-sdk/src/auth/index.ts';
import { loadRuntimeConfig, setRuntimeConfig, type RuntimeConfig } from '../../packages/frontend-sdk/src/config/index.ts';
import { initializeCore, setConsentProvider, type ConsentCategory, type ConsentProvider } from '../../packages/frontend-sdk/src/core/index.ts';
import { setTokenSource } from '../../packages/frontend-sdk/src/http/index.ts';
import { resetRuntimeForTests } from '../../packages/frontend-sdk/src/internal/runtime.ts';
import { initializeLogging } from '../../packages/frontend-sdk/src/logging/index.ts';
import { initializeMetrics } from '../../packages/frontend-sdk/src/metrics/index.ts';
import { resetContainersForTests } from '../../packages/frontend-sdk/src/mfe/remote.ts';
import { initializeTracing } from '../../packages/frontend-sdk/src/tracing/index.ts';
import { testenv } from '../testenv/index.ts';
import { FakeBroadcastChannel, FakeKeycloak, FakePage, IDP } from './keycloak.ts';
import { FakeNetwork } from './network.ts';
import { Collector, unloadTelemetry } from './telemetry.ts';

export const ACME: Workspace = { realm: 'tenant-acme', trial: false, slug: 'acme' };

/** /config/runtime.json as the shell's deploy writes it, pointed at the fake Keycloak, every trace sampled. */
export function runtimeConfigJson(o: { telemetry?: Record<string, unknown>; remotes?: Record<string, unknown>; flags?: Record<string, unknown> } = {}) {
  return {
    api: { baseUrl: '/api' },
    telemetry: { otlpBaseUrl: '/otel', sampleRatio: 1, logLevel: 'debug', ...o.telemetry },
    auth: { idpOrigin: IDP, idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
    flags: { ...o.flags },
    remotes: { loadTimeoutMs: 10_000, retries: 0, ...o.remotes },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
    appUpdate: { pollIntervalMs: 300_000 },
  };
}

/** A consent manager: essential only until the user accepts more. */
export function consentManager(granted: ConsentCategory[] = ['essential']): ConsentProvider & { accept(c: ConsentCategory[]): void } {
  const set = new Set<ConsentCategory>(['essential', ...granted]);
  const listeners = new Set<() => void>();
  return {
    has: (c) => set.has(c),
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    accept(c) {
      for (const x of c) set.add(x);
      for (const l of [...listeners]) l();
    },
  };
}

/** One browser tab and the services behind it. */
export class World {
  readonly kc = new FakeKeycloak();
  readonly net = new FakeNetwork(this.kc);
  readonly collector = new Collector().install();
  readonly page: FakePage;
  readonly resolver: WorkspaceResolver = { resolve: async (id) => (id === 'acme' ? ACME : undefined) };
  consent = consentManager(['telemetry']);
  cfg!: RuntimeConfig;
  idp!: IdentityProvider;

  constructor(path = '/', config: ReturnType<typeof runtimeConfigJson> = runtimeConfigJson()) {
    this.page = new FakePage(path);
    this.net.on('GET /config/runtime.json', config);
    vi.stubGlobal('fetch', this.net.fetch);
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  }

  /**
   * A page load: a fresh SDK runtime on this tab, booted in the order of design doc §C2 (core →
   * runtime config → consent → tracing, logging, metrics → auth), then idp.init().
   */
  async load(): Promise<SessionState> {
    await unloadTelemetry();
    resetRuntimeForTests();
    resetContainersForTests();
    this.page.install();
    initializeCore({ serviceName: 'web-app', domain: testenv.domain, environment: testenv.environment, buildVersion: '1.0.0' });
    this.cfg = await loadRuntimeConfig();
    setRuntimeConfig(this.cfg);
    setConsentProvider(this.consent);
    const { otlpBaseUrl, sampleRatio, logLevel } = this.cfg.telemetry;
    initializeTracing({ otlpBaseUrl, sampleRatio, propagationAllowlist: this.cfg.api.propagationAllowlist });
    initializeLogging({ otlpBaseUrl, level: logLevel });
    initializeMetrics({ otlpBaseUrl });
    this.idp = createOidcProvider(this.cfg.auth, this.resolver);
    setTokenSource(initializeAuth(this.idp));
    return this.idp.init();
  }

  /** Interactive login (PKCE) to `w`; the user signs in at Keycloak; the callback page loads. */
  async signIn(w: Workspace = ACME, returnUrl = '/t/acme/'): Promise<SessionState> {
    await this.load();
    await this.idp.login({ workspace: w, returnUrl });
    this.page.url = new URL(this.kc.approve(this.page.assigned.at(-1)!));
    return this.load();
  }
}

/** Fake clock and timers as in the /auth unit tests; WebCrypto still settles on the real event loop. */
export function useFakeClock(): void {
  vi.useFakeTimers({ now: new Date('2026-10-30T10:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

/** Resets what outlives one test: timers, globals, mocks, the other "tabs" and the SDK runtime. */
export async function endWorld(): Promise<void> {
  await unloadTelemetry();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeBroadcastChannel.reset();
  resetContainersForTests();
  resetRuntimeForTests();
}
