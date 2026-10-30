import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeConfigSchema, setRuntimeConfig } from '../../src/config/index.ts';
import {
  getFlag,
  isRemoteKilled,
  runtimeConfigFlagProvider,
  sessionContextFlagProvider,
  setFlagProvider,
  type FlagProvider,
} from '../../src/flags/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';

const config = (flags: Record<string, boolean | string | number>, killSwitch: string[] = []) =>
  setRuntimeConfig(
    RuntimeConfigSchema.parse({
      api: { baseUrl: '/api' },
      telemetry: {},
      auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
      flags,
      remotes: { loadTimeoutMs: 10_000, retries: 2, killSwitch },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
      appUpdate: { pollIntervalMs: 300_000 },
    }),
  );

beforeEach(() => resetRuntimeForTests());

describe('getFlag', () => {
  it('returns the fallback without a config (a remote run standalone)', () => {
    expect(getFlag('new_editor', false)).toBe(false);
    expect(getFlag('limit', 10)).toBe(10);
  });

  it('reads runtime-config flags by default, typed by the fallback', () => {
    config({ new_editor: true, 'llm.refiner.query': 'v2', limit: 25 });
    expect(getFlag('new_editor', false)).toBe(true);
    expect(getFlag('llm.refiner.query', 'v1')).toBe('v2');
    expect(getFlag('limit', 10)).toBe(25);
    expect(getFlag('limit', 'x')).toBe('x'); // wrong type: fallback
    expect(getFlag('missing', true)).toBe(true);
    expect(getFlag('constructor', false)).toBe(false); // own keys only
  });

  it('falls back when the provider throws or answers a non-finite number', () => {
    setFlagProvider({ get: () => { throw new Error('x'); }, subscribe: () => () => {} });
    expect(getFlag('a', true)).toBe(true);
    setFlagProvider({ get: () => Number.NaN, subscribe: () => () => {} });
    expect(getFlag('a', 3)).toBe(3);
    setFlagProvider(undefined as unknown as FlagProvider);
    expect(getFlag('a', 'fallback')).toBe('fallback');
  });
});

describe('sessionContextFlagProvider', () => {
  it('adds tenant flags (presence = true) and read_only to the runtime-config flags', () => {
    config({ sso_enabled: true });
    setFlagProvider(sessionContextFlagProvider({ featureFlags: ['ai_drafting', 'read_only'], readOnly: false }));
    expect(getFlag('ai_drafting', false)).toBe(true);
    expect(getFlag('sso_enabled', false)).toBe(true);
    expect(getFlag('read_only', false)).toBe(true); // x-feature-flags carries read_only too
    expect(getFlag('not_granted', false)).toBe(false);
    setFlagProvider(sessionContextFlagProvider({ featureFlags: [], readOnly: true }));
    expect(getFlag('read_only', false)).toBe(true);
  });

  it('lets a platform flag override a tenant flag (kill switch, rollout)', () => {
    config({ ai_drafting: false });
    setFlagProvider(sessionContextFlagProvider({ featureFlags: ['ai_drafting'], readOnly: false }));
    expect(getFlag('ai_drafting', true)).toBe(false);
  });

  it('read_only is true when the platform or the tenant says so: a platform false never lifts it', () => {
    config({ read_only: false });
    expect(sessionContextFlagProvider({ featureFlags: [], readOnly: true }).get('read_only')).toBe(true);
    expect(sessionContextFlagProvider({ featureFlags: ['read_only'], readOnly: false }).get('read_only')).toBe(true);
    expect(sessionContextFlagProvider({ featureFlags: [], readOnly: false }).get('read_only')).toBe(false);
    resetRuntimeForTests();
    config({ read_only: true });
    setFlagProvider(sessionContextFlagProvider({ featureFlags: [], readOnly: false }));
    expect(getFlag('read_only', false)).toBe(true);
  });

  it('tolerates a malformed context', () => {
    const p = sessionContextFlagProvider({ featureFlags: 'x' as never, readOnly: 'yes' as never });
    expect(p.get('x')).toBeUndefined();
    expect(p.get('read_only')).toBe(false);
    expect(typeof p.subscribe(() => {})).toBe('function');
    expect(typeof runtimeConfigFlagProvider().subscribe(() => {})).toBe('function');
  });
});

describe('isRemoteKilled', () => {
  it('is true for the config kill switch or flag remote.<name>.disabled', () => {
    config({ 'remote.iam-admin.disabled': true, 'remote.reports.disabled': 'yes' }, ['tenders']);
    expect(isRemoteKilled('tenders')).toBe(true);
    expect(isRemoteKilled('iam-admin')).toBe(true);
    expect(isRemoteKilled('reports')).toBe(false); // not a boolean
    expect(isRemoteKilled('dashboard')).toBe(false);
  });

  it('is false without a config', () => {
    expect(isRemoteKilled('tenders')).toBe(false);
  });
});
