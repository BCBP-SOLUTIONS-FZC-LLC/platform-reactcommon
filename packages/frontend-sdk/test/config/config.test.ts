import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeConfigError,
  RuntimeConfigSchema,
  getConfig,
  loadRuntimeConfig,
  setRuntimeConfig,
  tryGetConfig,
  type RuntimeConfig,
} from '../../src/config/index.ts';
import { NotInitializedError, initializeCore, type Environment } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';

/** The fields a runtime.json must always spell out; everything else has a design-doc default. */
const minimal = () => ({
  api: { baseUrl: '/api' },
  telemetry: {},
  auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
  remotes: { loadTimeoutMs: 10_000, retries: 2 },
  i18n: { defaultLocale: 'en', supportedLocales: ['en', 'ar'] },
  appUpdate: { pollIntervalMs: 300_000 },
});

const parse = (raw: unknown) => RuntimeConfigSchema.safeParse(raw);
const issuePaths = (raw: unknown) => {
  const r = parse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};
const withPatch = (path: string, value: unknown) => {
  const c = minimal() as Record<string, unknown>;
  const keys = path.split('.');
  let o = c;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[keys.at(-1)!] = value;
  return c;
};

beforeEach(() => resetRuntimeForTests());
afterEach(() => vi.unstubAllGlobals());

describe('RuntimeConfigSchema', () => {
  it('applies the design-doc defaults', () => {
    const r = parse(minimal());
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      api: { baseUrl: '/api', timeoutMs: 35_000, propagationAllowlist: [] },
      telemetry: { enabled: true, otlpBaseUrl: '/otel', sampleRatio: 0.1, logLevel: 'info', sendSessionHeader: true },
      auth: {
        idpOrigin: 'https://auth.bcbpsolutions.com',
        trialRealm: 'trial',
        paidRealmPrefix: 'tenant-',
        workspacePathPrefix: '/t/',
        clientId: 'tender-web',
        scopes: ['openid'],
        idleTimeoutMs: 1_800_000,
        redirectPath: '/auth/callback',
      },
      flags: {},
      remotes: { killSwitch: [], loadTimeoutMs: 10_000, retries: 2, allowedOrigins: [] },
      i18n: { defaultLocale: 'en', supportedLocales: ['en', 'ar'] },
      appUpdate: { pollIntervalMs: 300_000 },
    });
  });

  it.each([
    'api.baseUrl',
    'auth.idleTimeoutMs',
    'auth.redirectPath',
    'remotes.loadTimeoutMs',
    'remotes.retries',
    'i18n.defaultLocale',
    'appUpdate.pollIntervalMs',
  ])('requires %s (no default in the design doc)', (path) => {
    expect(issuePaths(withPatch(path, undefined))).toContain(path);
  });

  it('rejects unknown keys at every level', () => {
    expect(issuePaths({ ...minimal(), extra: 1 })).toEqual(['']);
    for (const section of ['api', 'telemetry', 'auth', 'remotes', 'i18n', 'appUpdate']) {
      expect(issuePaths(withPatch(`${section}.typo`, 1)), section).toEqual([section]);
    }
  });

  it.each([
    ['https://auth.example.com', true],
    ['http://localhost:8080', true],
    ['http://127.0.0.1', true],
    ['http://auth.example.com', false],
    ['https://auth.example.com/', false],
    ['https://auth.example.com/realms', false],
    ['https://user@auth.example.com', false],
    ['auth.example.com', false],
  ])('accepts %s as an exact origin: %s', (origin, ok) => {
    expect(parse(withPatch('auth.idpOrigin', origin)).success).toBe(ok);
    expect(parse(withPatch('api.propagationAllowlist', [origin])).success).toBe(ok);
    expect(parse(withPatch('remotes.allowedOrigins', [origin])).success).toBe(ok);
  });

  it.each([
    ['/api', true],
    ['/api/v1', true],
    ['/', true],
    ['api', false],
    ['//evil.example/api', false],
    ['https://example.com/api', false],
    ['/api?x=1', false],
    ['/api#x', false],
    ['/a\\b', false],
    ['/a/../b', false],
    ['/a b', false],
  ])('accepts %s as a same-origin path: %s', (path, ok) => {
    expect(parse(withPatch('api.baseUrl', path)).success).toBe(ok);
    expect(parse(withPatch('auth.redirectPath', path)).success).toBe(ok);
  });

  it('bounds the numbers', () => {
    expect(issuePaths(withPatch('auth.idleTimeoutMs', 8 * 3_600_000))).toEqual([]);
    expect(issuePaths(withPatch('auth.idleTimeoutMs', 8 * 3_600_000 + 1))).toEqual(['auth.idleTimeoutMs']);
    expect(issuePaths(withPatch('telemetry.sampleRatio', 1.5))).toEqual(['telemetry.sampleRatio']);
    expect(issuePaths(withPatch('telemetry.sampleRatio', -0.1))).toEqual(['telemetry.sampleRatio']);
    expect(issuePaths(withPatch('api.timeoutMs', 35.5))).toEqual(['api.timeoutMs']);
    expect(issuePaths(withPatch('remotes.retries', 6))).toEqual(['remotes.retries']);
    expect(issuePaths(withPatch('appUpdate.pollIntervalMs', 1_000))).toEqual(['appUpdate.pollIntervalMs']);
  });

  it('checks the auth values the realm logic depends on', () => {
    expect(issuePaths(withPatch('auth.scopes', ['profile']))).toEqual(['auth.scopes']);
    expect(issuePaths(withPatch('auth.scopes', ['openid', 'bad scope']))).toEqual(['auth.scopes.1']);
    expect(issuePaths(withPatch('auth.paidRealmPrefix', 'tenant'))).toEqual(['auth.paidRealmPrefix']);
    expect(issuePaths(withPatch('auth.workspacePathPrefix', '/t'))).toEqual(['auth.workspacePathPrefix']);
    expect(issuePaths(withPatch('auth.trialRealm', 'tenant-trial'))).toEqual(['auth.trialRealm']);
    expect(issuePaths(withPatch('auth.trialRealm', 'Trial'))).toEqual(['auth.trialRealm']);
  });

  it('checks locales are canonical and the default is supported', () => {
    expect(issuePaths(withPatch('i18n.defaultLocale', 'en-us'))).toContain('i18n.defaultLocale');
    expect(issuePaths(withPatch('i18n.supportedLocales', ['ar', 'x-not-a-tag!']))).toContain('i18n.supportedLocales.1');
    expect(issuePaths(withPatch('i18n.supportedLocales', ['ar']))).toEqual(['i18n.supportedLocales']);
    expect(issuePaths(withPatch('i18n.supportedLocales', []))).toContain('i18n.supportedLocales');
  });

  it('accepts flags as opaque names with boolean, string or finite number values', () => {
    expect(issuePaths(withPatch('flags', { sso_enabled: true, 'llm.refiner.query': 'v2', 'rollout.pct': 25 }))).toEqual([]);
    expect(issuePaths(withPatch('flags', { x: null }))).toEqual(['flags.x']);
    expect(issuePaths(withPatch('flags', { x: { nested: true } }))).toEqual(['flags.x']);
    expect(issuePaths(withPatch('flags', { '': true }))).toEqual(['flags.']); // the empty key itself
  });

  it('checks kill-switch names against the mfe label pattern', () => {
    expect(issuePaths(withPatch('remotes.killSwitch', ['tenders', 'iam-admin']))).toEqual([]);
    expect(issuePaths(withPatch('remotes.killSwitch', ['Tenders']))).toEqual(['remotes.killSwitch.0']);
  });
});

describe('setRuntimeConfig / getConfig / tryGetConfig', () => {
  const config = () => RuntimeConfigSchema.parse(minimal());

  it('is empty before the shell sets it', () => {
    expect(tryGetConfig()).toBeUndefined();
    expect(() => getConfig()).toThrow(NotInitializedError);
  });

  it('stores a deep-frozen, validated copy', () => {
    setRuntimeConfig(config());
    const c = getConfig();
    expect(tryGetConfig()).toBe(c);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.auth)).toBe(true);
    expect(Object.isFrozen(c.auth.scopes)).toBe(true);
    expect(Object.isFrozen(c.i18n.supportedLocales)).toBe(true);
    expect(() => (c.auth.scopes as string[]).push('x')).toThrow();
  });

  it('is set once: equal again is a no-op, different throws', () => {
    setRuntimeConfig(config());
    const first = getConfig();
    setRuntimeConfig(config());
    expect(getConfig()).toBe(first);
    expect(() => setRuntimeConfig({ ...config(), flags: { x: true } })).toThrow('already set');
  });

  it('rejects an invalid config with RuntimeConfigError issues', () => {
    const bad = { ...config(), api: { ...config().api, baseUrl: 'https://evil.example' } } as RuntimeConfig;
    try {
      setRuntimeConfig(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimeConfigError);
      expect((e as RuntimeConfigError).issues.map((i) => i.path)).toEqual(['api.baseUrl']);
    }
    expect(tryGetConfig()).toBeUndefined();
  });
});

describe('http origins on a local host', () => {
  const identity = (environment: Environment) =>
    initializeCore({ serviceName: 'web-app', domain: 'portal', environment, buildVersion: '1.0.0' });
  const withLocal = (origin: string) => {
    const c = withPatch('auth.idpOrigin', origin);
    (c.api as Record<string, unknown>).propagationAllowlist = ['https://api.example.com', origin];
    (c.remotes as Record<string, unknown>).allowedOrigins = [origin];
    return c;
  };
  const LOCAL_PATHS = ['auth.idpOrigin', 'api.propagationAllowlist.1', 'remotes.allowedOrigins.0'];

  it.each(['prod', 'staging', 'test'] as const)('are refused by setRuntimeConfig in %s', (env) => {
    identity(env);
    for (const origin of ['http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:3000']) {
      const err = (() => {
        try {
          setRuntimeConfig(withLocal(origin) as unknown as RuntimeConfig);
        } catch (e) {
          return e;
        }
      })();
      expect(err, origin).toBeInstanceOf(RuntimeConfigError);
      expect((err as RuntimeConfigError).issues.map((i) => i.path)).toEqual(LOCAL_PATHS);
      expect((err as Error).message).toContain(`page environment: ${env}`);
      expect(tryGetConfig()).toBeUndefined();
    }
  });

  it('are refused before initializeCore (the environment is unknown)', () => {
    expect(() => setRuntimeConfig(withLocal('http://localhost:8080') as unknown as RuntimeConfig)).toThrow(/initializeCore not called/);
  });

  it('are refused by loadRuntimeConfig in prod', async () => {
    identity('prod');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(withLocal('http://localhost:8080')))));
    const err = await loadRuntimeConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeConfigError);
    expect((err as RuntimeConfigError).issues.map((i) => i.path)).toEqual(LOCAL_PATHS);
  });

  it.each(['local', 'dev'] as const)('are accepted in %s', async (env) => {
    identity(env);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(withLocal('http://localhost:8080')))));
    const loaded = await loadRuntimeConfig();
    setRuntimeConfig(loaded);
    expect(getConfig().auth.idpOrigin).toBe('http://localhost:8080');
    expect(getConfig().remotes.allowedOrigins).toEqual(['http://localhost:8080']);
  });

  it('do not affect https origins in prod', () => {
    identity('prod');
    setRuntimeConfig(withPatch('auth.idpOrigin', 'https://auth.example.com') as unknown as RuntimeConfig);
    expect(getConfig().auth.idpOrigin).toBe('https://auth.example.com');
  });
});

describe('loadRuntimeConfig', () => {
  const respond = (body: string, init: ResponseInit = { status: 200 }) =>
    vi.fn<typeof fetch>(async () => new Response(body, init));

  it('fetches /config/runtime.json without HTTP caching and validates it', async () => {
    const fetchMock = respond(JSON.stringify(minimal()));
    vi.stubGlobal('fetch', fetchMock);
    const c = await loadRuntimeConfig();
    expect(c.api.timeoutMs).toBe(35_000);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/config/runtime.json');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-cache', credentials: 'same-origin' });
    expect(tryGetConfig()).toBeUndefined(); // loading does not set it
  });

  it('passes the caller signal through and rethrows its abort as is', async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw abort;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRuntimeConfig({ url: '/cfg.json', signal: controller.signal })).rejects.toBe(abort);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(controller.signal);
  });

  it.each([
    ['a network failure', vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('Failed to fetch'))), 'could not be loaded'],
    ['an HTTP error', respond('nope', { status: 503 }), 'HTTP 503'],
    ['invalid JSON', respond('{'), 'not valid JSON'],
    ['a schema violation', respond(JSON.stringify({ ...minimal(), api: {} })), 'api.baseUrl'],
  ])('turns %s into a RuntimeConfigError', async (_, fetchMock, message) => {
    vi.stubGlobal('fetch', fetchMock);
    const err = await loadRuntimeConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeConfigError);
    expect((err as Error).message).toContain(message);
  });

  it('refuses a URL that is not a same-origin path', async () => {
    const fetchMock = respond('{}');
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRuntimeConfig({ url: 'https://evil.example/runtime.json' })).rejects.toBeInstanceOf(RuntimeConfigError);
    await expect(loadRuntimeConfig({ url: '//evil.example/runtime.json' })).rejects.toBeInstanceOf(RuntimeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RuntimeConfigError messages (zod/mini has no default messages)', () => {
  // Each built-in issue is worded from its own fields; "Invalid input" never reaches the operator.
  // path → every message for it (one value can fail several checks)
  const messages = (raw: unknown): Record<string, string[]> => {
    try {
      setRuntimeConfig(raw as RuntimeConfig);
      return {};
    } catch (e) {
      const out: Record<string, string[]> = {};
      for (const i of (e as RuntimeConfigError).issues) (out[i.path] ??= []).push(i.message);
      return out;
    }
  };

  beforeEach(() => resetRuntimeForTests());

  it('names unknown keys, wrong types, ranges, list sizes and enum values', () => {
    const c = minimal() as Record<string, Record<string, unknown>>;
    const got = messages({
      ...c,
      api: { ...c.api, typo: 1, tpyo: 2 },
      telemetry: { logLevel: 'trace', sampleRatio: 2 },
      remotes: { loadTimeoutMs: 10, retries: 'x' },
      i18n: { defaultLocale: 'en', supportedLocales: [] },
      appUpdate: { pollIntervalMs: 1.5 },
    });
    expect(got).toEqual({
      api: ['unknown keys "typo", "tpyo"'],
      'telemetry.logLevel': ['must be one of "debug", "info", "warn", "error"'],
      'telemetry.sampleRatio': ['must be ≤ 1'],
      'remotes.loadTimeoutMs': ['must be ≥ 1000'],
      'remotes.retries': ['expected a number'],
      'i18n.supportedLocales': ['must have at least 1 item', 'must include defaultLocale'],
      'appUpdate.pollIntervalMs': ['expected an integer'],
    });
    expect(Object.values(got).flat()).not.toContain('Invalid input');
  });

  it('keeps the messages the schema sets itself', () => {
    const c = minimal() as Record<string, Record<string, unknown>>;
    expect(messages({ ...c, api: { baseUrl: 'https://evil.example' }, flags: { x: Number.NaN } })).toEqual({
      'api.baseUrl': [`must be a same-origin path such as '/api', got "https://evil.example"`],
      'flags.x': ['must be a boolean, a string or a finite number'],
    });
  });
});
