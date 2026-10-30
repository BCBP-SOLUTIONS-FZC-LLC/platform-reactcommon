import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('parsing the runtime config never builds code at runtime (CSP script-src self)', async () => {
  const constructed = vi.fn();
  const RealFunction = globalThis.Function;
  vi.stubGlobal(
    'Function',
    new Proxy(RealFunction, {
      construct(target, args) {
        constructed(args);
        throw new EvalError('Refused to evaluate a string as JavaScript (CSP)');
      },
      apply(target, thisArg, args) {
        constructed(args);
        throw new EvalError('Refused to evaluate a string as JavaScript (CSP)');
      },
    }),
  );
  vi.resetModules();
  const { RuntimeConfigSchema } = await import('../../src/config/index.ts');
  const cfg = RuntimeConfigSchema.parse({
    api: { baseUrl: '/api' },
    telemetry: {},
    auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
    remotes: { loadTimeoutMs: 10_000, retries: 2 },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
    appUpdate: { pollIntervalMs: 300_000 },
  });
  expect(cfg.api.baseUrl).toBe('/api');
  expect(constructed).not.toHaveBeenCalled();
});
