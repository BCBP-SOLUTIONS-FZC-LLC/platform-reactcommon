import { beforeEach, describe, expect, it } from 'vitest';
import { hasConsent, setConsentProvider, type ConsentCategory, type ConsentProvider } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';

const provider = (granted: ConsentCategory[]): ConsentProvider => ({
  has: (c) => granted.includes(c),
  subscribe: () => () => {},
});

beforeEach(() => resetRuntimeForTests());

describe('consent', () => {
  it('grants essential only by default', () => {
    expect(hasConsent('essential')).toBe(true);
    expect(hasConsent('telemetry')).toBe(false);
    expect(hasConsent('analytics')).toBe(false);
  });

  it("follows the shell's provider", () => {
    setConsentProvider(provider(['telemetry']));
    expect(hasConsent('telemetry')).toBe(true);
    expect(hasConsent('analytics')).toBe(false);
  });

  it('always grants essential, even if the provider says otherwise', () => {
    setConsentProvider(provider([]));
    expect(hasConsent('essential')).toBe(true);
  });

  it('fails closed when the provider throws or answers anything but true', () => {
    setConsentProvider({
      has: () => {
        throw new Error('cmp not ready');
      },
      subscribe: () => () => {},
    });
    expect(hasConsent('telemetry')).toBe(false);
    setConsentProvider({ has: () => 'yes' as unknown as boolean, subscribe: () => () => {} });
    expect(hasConsent('analytics')).toBe(false);
  });

  it('falls back to essential only when given no provider', () => {
    setConsentProvider(provider(['telemetry']));
    setConsentProvider(undefined as unknown as ConsentProvider);
    expect(hasConsent('telemetry')).toBe(false);
  });
});
