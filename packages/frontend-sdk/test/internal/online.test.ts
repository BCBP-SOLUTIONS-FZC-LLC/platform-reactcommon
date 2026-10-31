import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOnline, subscribeOnline } from '../../src/internal/online.ts';

afterEach(() => vi.unstubAllGlobals());

describe('online state outside a browser', () => {
  it('reports online without a navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isOnline()).toBe(true);
  });

  it('subscribes to nothing without window events, and unsubscribing is harmless', () => {
    vi.stubGlobal('addEventListener', undefined);
    const l = vi.fn();
    const off = subscribeOnline(l);
    expect(() => off()).not.toThrow();
    expect(l).not.toHaveBeenCalled();
  });
});
