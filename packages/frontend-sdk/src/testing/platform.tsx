// createTestPlatform (design doc §C1 /testing): a real SDK runtime for a remote's component tests, with
// in-memory log and span exporters, a signed-in fake identity provider, role-map permissions and flags.
import { context as otelContext, trace } from '@opentelemetry/api';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import type { ComponentType, ReactNode } from 'react';
import { initializeAuth, type IdentityProvider, type SessionContext, type SessionState, type SessionUser, type Workspace } from '../auth/index.ts';
import { roleMapAuthorizer, setAuthorizer, setAuthzSubject } from '../authz/index.ts';
import { RuntimeConfigSchema, setRuntimeConfig, type RuntimeConfig } from '../config/index.ts';
import { initializeCore, setConsentProvider, type CoreIdentityInput } from '../core/index.ts';
import { setFlagProvider, type FlagValue } from '../flags/index.ts';
import { setLoggingInternalsForTests, initializeLogging } from '../logging/logging.ts';
import { PlatformProvider } from '../react/index.ts';
import { setTracingInternalsForTests, initializeTracing } from '../tracing/tracing.ts';
import { resetRuntimeForTests } from '../internal/runtime.ts';
import { restoreFetch } from './mock-api.ts';

/** One log record as the collector would receive it. */
export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly body: string;
  /** Envelope (trace_id, request_id, session_id, mfe, page_route, …) and caller attributes, redacted. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** One ended span as the collector would receive it. */
export interface SpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly status: 'unset' | 'ok' | 'error';
  readonly events: readonly { readonly name: string; readonly attributes: Readonly<Record<string, unknown>> }[];
}

interface TestPlatformOptions {
  identity: CoreIdentityInput;
  config: Partial<RuntimeConfig>;
  user: SessionUser;
  workspace: Workspace;
  context: Partial<SessionContext>;
  /** 'action:resource' grants of the signed-in user; none by default (deny all, as in production without a role). */
  permissions: readonly `${string}:${string}`[];
  flags: Record<string, FlagValue>;
}

const DEFAULT_IDENTITY: CoreIdentityInput = { serviceName: 'test-app', domain: 'tender_management', environment: 'test', buildVersion: '0.0.0-test' };
const DEFAULT_USER: SessionUser = { sub: 'test-user', name: 'Test User', email: 'test.user@example.com' };
const DEFAULT_WORKSPACE: Workspace = { realm: 'tenant-test', trial: false, slug: 'test' };
const TEST_ROLE = 'test-role';
const LEVELS: Record<string, LogRecord['level']> = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' };
const STATUS = ['unset', 'ok', 'error'] as const;

function testConfig(c: Partial<RuntimeConfig> | undefined): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    ...c,
    api: { baseUrl: '/api', ...c?.api },
    telemetry: { otlpBaseUrl: '/otel', sampleRatio: 1, logLevel: 'debug', ...c?.telemetry },
    auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback', ...c?.auth },
    remotes: { loadTimeoutMs: 10_000, retries: 0, ...c?.remotes },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'], ...c?.i18n },
    appUpdate: { pollIntervalMs: 300_000, ...c?.appUpdate },
  });
}

/** A signed-in IdentityProvider that never redirects: login and step-up only record the call. */
function fakeIdentityProvider(user: SessionUser, workspace: Workspace): IdentityProvider {
  const state: SessionState = { status: 'authenticated', user, workspace, expiresAt: Date.now() + 300_000 };
  const listeners = new Set<(s: SessionState) => void>();
  const redirectListeners = new Set<(r: { reason: 'step-up' | 'restore' | 'login' | 'switch' }) => void>();
  const redirect = async (reason: 'step-up' | 'login' | 'switch') => {
    for (const l of [...redirectListeners]) l({ reason });
  };
  return {
    init: async () => state,
    login: () => redirect('login'),
    logout: async () => {},
    getAccessToken: async () => 'test-access-token',
    refresh: async () => true,
    switchWorkspace: () => redirect('switch'),
    reauthenticate: () => redirect('step-up'),
    needsStepUp: (maxAgeSeconds) => user.authTime !== undefined && Date.now() / 1000 - user.authTime > maxAgeSeconds,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    beforeRedirect: (l) => {
      redirectListeners.add(l);
      return () => redirectListeners.delete(l);
    },
    getState: () => state,
  };
}

/**
 * A fresh SDK runtime for one test: core, config, logging and tracing (to in-memory arrays), a signed-in
 * session, permissions, flags and the shell's PlatformProvider as `Wrapper`. Calling it again starts over.
 * `reset()` empties `logs` and `spans` and undoes mockApi.
 */
export function createTestPlatform(o?: Partial<TestPlatformOptions>): {
  Wrapper: ComponentType<{ children: ReactNode }>;
  logs: LogRecord[];
  spans: SpanRecord[];
  reset(): void;
} {
  // Start from an empty page: the OTel globals refuse a second registration until disabled.
  trace.disable();
  otelContext.disable();
  restoreFetch();
  resetRuntimeForTests();

  const logs: LogRecord[] = [];
  const spans: SpanRecord[] = [];
  const logExporter: LogRecordExporter = {
    export: (records: ReadableLogRecord[], cb) => {
      for (const r of records) {
        logs.push({
          level: LEVELS[r.severityText ?? ''] ?? 'info',
          body: String(r.body),
          attributes: { ...(r.attributes as Record<string, unknown>) },
        });
      }
      cb({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const spanExporter: SpanExporter = {
    export: (batch: ReadableSpan[], cb) => {
      for (const s of batch) {
        const parent = s.parentSpanContext?.spanId;
        spans.push({
          name: s.name,
          traceId: s.spanContext().traceId,
          spanId: s.spanContext().spanId,
          ...(parent ? { parentSpanId: parent } : {}),
          attributes: { ...s.attributes },
          status: STATUS[s.status.code] ?? 'unset',
          events: s.events.map((e) => ({ name: e.name, attributes: { ...e.attributes } })),
        });
      }
      cb({ code: 0 });
    },
    shutdown: async () => {},
  };

  initializeCore({ ...DEFAULT_IDENTITY, ...o?.identity });
  const config = testConfig(o?.config);
  setRuntimeConfig(config);
  setConsentProvider({ has: () => true, subscribe: () => () => {} });
  setLoggingInternalsForTests({ exporter: () => logExporter });
  setTracingInternalsForTests({ exporter: () => spanExporter, queue: { maxQueueSize: 10_000, maxExportBatchSize: 1, scheduledDelayMillis: 100 } });
  initializeLogging({ otlpBaseUrl: config.telemetry.otlpBaseUrl, level: config.telemetry.logLevel, batchSize: 1 });
  initializeTracing({ otlpBaseUrl: config.telemetry.otlpBaseUrl, sampleRatio: 1, propagationAllowlist: config.api.propagationAllowlist });

  const user = o?.user ?? DEFAULT_USER;
  const workspace = o?.workspace ?? DEFAULT_WORKSPACE;
  const context: SessionContext = {
    tenantId: '00000000-0000-4000-8000-000000000000',
    slug: workspace.slug ?? 'test',
    roles: ['member'],
    departments: [],
    featureFlags: [],
    readOnly: false,
    ...o?.context,
  };
  initializeAuth(fakeIdentityProvider(user, workspace));
  setAuthorizer(roleMapAuthorizer({ [TEST_ROLE]: o?.permissions ?? [] }));
  setAuthzSubject({ roles: [TEST_ROLE], tenantId: context.tenantId });
  const flags = { ...o?.flags };
  setFlagProvider({ get: (k) => flags[k] ?? config.flags[k], subscribe: () => () => {} });

  const shell = { user, workspace, context, locale: config.i18n.defaultLocale, switchWorkspace: async () => {} };
  function Wrapper({ children }: { children: ReactNode }) {
    return <PlatformProvider shell={shell}>{children}</PlatformProvider>;
  }
  return {
    Wrapper,
    logs,
    spans,
    reset() {
      logs.length = 0;
      spans.length = 0;
      restoreFetch();
    },
  };
}
