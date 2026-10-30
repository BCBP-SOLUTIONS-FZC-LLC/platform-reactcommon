import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_INSTRUMENTS } from '../../src/internal/instruments.ts';
import { RUNTIME_KEY, getRuntime, resetRuntimeForTests, type PlatformRuntime } from '../../src/internal/runtime.ts';

type RuntimeModule = typeof import('../../src/internal/runtime.ts');
const slot = () => (globalThis as { [RUNTIME_KEY]?: PlatformRuntime })[RUNTIME_KEY];

/** A second copy of the SDK: a fresh module instance with its own owner marker. */
async function loadSecondCopy(): Promise<RuntimeModule> {
  vi.resetModules();
  return import('../../src/internal/runtime.ts');
}

beforeEach(() => resetRuntimeForTests());
afterEach(() => vi.restoreAllMocks());

describe('PlatformRuntime', () => {
  it('is created once on globalThis under the registered symbol', () => {
    const rt = getRuntime();
    expect(slot()).toBe(rt);
    expect(getRuntime()).toBe(rt);
    expect(rt.sdkVersion).toBe(__SDK_VERSION__);
    expect(rt.identity).toBeUndefined();
    expect(rt.instruments).toBe(NOOP_INSTRUMENTS);
  });

  it('has no-op instruments until /metrics installs real ones', () => {
    const i = getRuntime().instruments;
    expect(() => {
      i.httpClient(0.1, { method: 'GET', route: '/x', status_class: '2xx', error_class: 'success', mfe: 'shell' });
      i.remoteLoad(1, { mfe: 'tenders', outcome: 'success' });
      i.webError({ source: 'boundary', mfe: 'tenders' });
    }).not.toThrow();
  });

  it('lets a duplicate copy with the same major version bind to it, with one error', async () => {
    const first = getRuntime();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const copy = await loadSecondCopy();
    expect(copy.getRuntime()).toBe(first);
    expect(copy.getRuntime()).toBe(first);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain('second copy');
    expect(error.mock.calls[0]![0]).toContain('uses the existing runtime');
  });

  it('gives a duplicate copy with another major version its own runtime', async () => {
    const first = getRuntime();
    (first as { sdkVersion: string }).sdkVersion = '2.0.0';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const copy = await loadSecondCopy();
    const own = copy.getRuntime();
    expect(own).not.toBe(first);
    expect(slot()).toBe(first);
    expect(error.mock.calls[0]![0]).toContain('Major versions differ');
  });

  it('does not warn when the same copy finds its own runtime after a module reload of a consumer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = getRuntime();
    resetRuntimeForTests();
    (globalThis as { [RUNTIME_KEY]?: PlatformRuntime })[RUNTIME_KEY] = rt;
    expect(getRuntime()).toBe(rt);
    expect(error).not.toHaveBeenCalled();
  });
});
