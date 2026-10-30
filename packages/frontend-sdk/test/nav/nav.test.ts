import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { isSafeRedirect, navigate, registerNavigator } from '../../src/nav/index.ts';

const BASE = 'https://app.bcbpsolutions.com/t/acme/tenders';

beforeEach(() => resetRuntimeForTests());
afterEach(() => vi.unstubAllGlobals());

describe('isSafeRedirect', () => {
  it.each([
    '/t/acme/tenders/42',
    '/t/acme/tenders?tab=bids#top',
    'tenders/42',
    '../dashboard',
    'https://app.bcbpsolutions.com/t/acme/',
    'http://app.bcbpsolutions.com/x', // same scheme as base? no: base is https
  ])('accepts or rejects %s against the page origin', (url) => {
    expect(isSafeRedirect(url, BASE)).toBe(!url.startsWith('http://'));
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash', '/\\evil.example'],
    ['backslashes', '\\\\evil.example'],
    ['tab inside', '/\t/evil.example'],
    ['newline inside', '/\n/evil.example'],
    ['leading space', ' /x'],
    ['nul', '/x\u0000'],
    ['line separator', '/x\u2028'],
    ['another origin', 'https://evil.example/t/acme'],
    ['look-alike host', 'https://app.bcbpsolutions.com.evil.example/'],
    ['other port', 'https://app.bcbpsolutions.com:8443/'],
    ['credentials', 'https://user:pass@app.bcbpsolutions.com/'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>1</script>'],
    ['empty', ''],
    ['not a string', 42 as unknown as string],
  ])('rejects %s', (_, url) => {
    expect(isSafeRedirect(url, BASE)).toBe(false);
  });

  it('uses the page as the default base and is false without one', () => {
    expect(isSafeRedirect('/x')).toBe(false);
    vi.stubGlobal('location', new URL(BASE));
    expect(isSafeRedirect('/x')).toBe(true);
    expect(isSafeRedirect('https://evil.example/')).toBe(false);
    expect(isSafeRedirect('/x', 'not a url')).toBe(false);
  });
});

describe('navigate', () => {
  it("goes through the shell's router", () => {
    const n = vi.fn();
    registerNavigator(n);
    navigate('tenders', '/tenders/42');
    navigate('shell', '/dashboard', { replace: true });
    expect(n.mock.calls).toEqual([
      ['tenders', '/tenders/42', undefined],
      ['shell', '/dashboard', { replace: true }],
    ]);
  });

  it('falls back to a page navigation without a router', () => {
    const assign = vi.fn();
    const replace = vi.fn();
    vi.stubGlobal('location', Object.assign(new URL(BASE), { assign, replace }));
    navigate('tenders', '/tenders/42');
    navigate('tenders', '/tenders/43', { replace: true });
    expect(assign).toHaveBeenCalledWith('/tenders/42');
    expect(replace).toHaveBeenCalledWith('/tenders/43');
  });

  it('refuses anything but a safe same-origin path, and bad app ids', () => {
    registerNavigator(vi.fn());
    for (const path of ['tenders/42', '//evil.example', 'https://app.bcbpsolutions.com/x', '/\\evil', '/x\ny']) {
      expect(() => navigate('tenders', path), path).toThrow(TypeError);
    }
    expect(() => navigate('Tenders', '/x')).toThrow(TypeError);
    expect(() => registerNavigator('x' as never)).toThrow(TypeError);
  });

  it('does nothing without a router or a page', () => {
    expect(() => navigate('tenders', '/x')).not.toThrow();
  });
});
