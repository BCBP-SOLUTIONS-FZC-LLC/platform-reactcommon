import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESSENTIAL_ONLY_CONSENT, RUNTIME_KEY, getRuntime, resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';

const slot = globalThis as { [RUNTIME_KEY]?: unknown };

beforeEach(() => resetRuntimeForTests());
afterEach(() => {
  resetRuntimeForTests();
  vi.restoreAllMocks();
});

describe('ESSENTIAL_ONLY_CONSENT', () => {
  it('grants essential only and has nothing to notify', () => {
    expect(ESSENTIAL_ONLY_CONSENT.has('essential')).toBe(true);
    expect(ESSENTIAL_ONLY_CONSENT.has('analytics')).toBe(false);
    const l = vi.fn();
    const off = ESSENTIAL_ONLY_CONSENT.subscribe(l);
    expect(() => off()).not.toThrow();
    expect(l).not.toHaveBeenCalled();
  });

  it('is the default consent of a new runtime', () => {
    expect(getRuntime().consent).toBe(ESSENTIAL_ONLY_CONSENT);
  });
});

describe('a second SDK copy on the page', () => {
  const version = () => {
    const v = getRuntime().sdkVersion;
    resetRuntimeForTests();
    return v;
  };

  it('shares the runtime of a copy with the same major version, with an error log', () => {
    const v = version();
    // The same major, or for a pre-release (1.0.0-alpha.N) the same version: alpha.N to alpha.N+1 is breaking.
    const foreign = { owner: {}, sdkVersion: v.includes('-') ? v : `${v.split('.')[0]}.999.0`, storageNamespace: 'tenant-acme' };
    slot[RUNTIME_KEY] = foreign;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getRuntime()).toBe(foreign);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('This copy uses the existing runtime.'));
  });

  it('keeps its own runtime next to another pre-release of the same major (review 3: alpha.3 next to alpha.4)', () => {
    const foreign = { owner: {}, sdkVersion: '1.0.0-alpha.0', storageNamespace: 'tenant-acme' };
    slot[RUNTIME_KEY] = foreign;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getRuntime()).not.toBe(foreign);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pre-release) versions differ'));
  });

  it('keeps its own runtime next to a different major version, so identity and consent are not shared', () => {
    const v = version();
    const foreign = { owner: {}, sdkVersion: `${Number(v.split('.')[0]) + 1}.0.0`, storageNamespace: 'tenant-acme' };
    slot[RUNTIME_KEY] = foreign;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = getRuntime();
    expect(rt).not.toBe(foreign);
    expect(rt.storageNamespace).toBe('anon');
    expect(rt.consent).toBe(ESSENTIAL_ONLY_CONSENT);
    expect(slot[RUNTIME_KEY]).toBe(foreign); // the other copy's runtime is left alone
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pre-release) versions differ'));
  });

  it('adopts, silently, a runtime this same copy created (e.g. after a module re-evaluation)', () => {
    const rt = getRuntime();
    resetRuntimeForTests();
    slot[RUNTIME_KEY] = rt;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getRuntime()).toBe(rt);
    expect(error).not.toHaveBeenCalled();
  });
});
