// @vitest-environment jsdom
// jsdom, not happy-dom: DOMPurify is tested against browsers and jsdom; happy-dom's parser lets a <script> through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { installTrustedTypesPolicy, isAllowedOrigin, sanitizeHtml } from '../../src/security/index.ts';

beforeEach(() => resetRuntimeForTests());
afterEach(() => vi.unstubAllGlobals());

describe('sanitizeHtml', () => {
  const clean = (html: string, o?: { allowLinks?: boolean }) => String(sanitizeHtml(html, o));

  it('keeps ordinary formatting', () => {
    expect(clean('<p>Hello <b>bold</b> <em>it</em><br><ul><li>one</li></ul></p>')).toBe('<p>Hello <b>bold</b> <em>it</em><br></p><ul><li>one</li></ul><p></p>');
  });

  it('removes scripts, event handlers, styles, forms and embedded content', () => {
    expect(clean('<img src="/img/x.png" onerror="alert(1)"><script>alert(2)</script>')).toBe('<img src="/img/x.png">');
    expect(clean('<img src="x.png">')).toBe('<img>'); // only http(s), mailto and absolute same-origin paths
    expect(clean('<p style="color:red" onclick="x()">t</p>')).toBe('<p>t</p>');
    expect(clean('<style>body{}</style><form action="/x"><input name="a"></form>ok')).toBe('ok');
    expect(clean('<iframe src="https://evil.example"></iframe><svg><script>1</script></svg>x')).toBe('x');
    expect(clean('<div data-secret="1">d</div>')).toBe('<div>d</div>');
  });

  it('removes links but keeps their text unless links are allowed', () => {
    expect(clean('<a href="https://example.com">site</a>')).toBe('site');
    expect(clean('<a href="https://example.com" target="_blank">site</a>', { allowLinks: true })).toBe(
      '<a href="https://example.com" rel="noopener noreferrer">site</a>',
    );
  });

  it('keeps only http(s), mailto and same-origin links', () => {
    const href = (h: string) => clean(`<a href="${h}">x</a>`, { allowLinks: true });
    expect(href('/tenders/1')).toContain('href="/tenders/1"');
    expect(href('mailto:a@b.example')).toContain('href="mailto:a@b.example"');
    expect(href('javascript:alert(1)')).toBe('<a>x</a>');
    expect(href('data:text/html,<script>1</script>')).toBe('<a>x</a>');
    expect(href('//evil.example/x')).toBe('<a>x</a>');
  });

  it('returns TrustedHTML when the browser has Trusted Types', async () => {
    const created: string[] = [];
    // DOMPurify detects Trusted Types when it is created, as it would at page load.
    vi.resetModules();
    vi.stubGlobal('trustedTypes', {
      createPolicy: (name: string, rules: { createHTML: (s: string) => string }) => {
        created.push(name);
        // Like a real TrustedHTML: an object that stringifies to its HTML.
        return { createHTML: (s: string) => ({ trusted: true, toString: () => rules.createHTML(String(s)) }) };
      },
      isHTML: () => false,
      emptyHTML: '',
    });
    const fresh = await import('../../src/security/index.ts');
    const out = fresh.sanitizeHtml('<b onclick="x()">x</b>');
    expect(typeof out).not.toBe('string');
    expect((out as unknown as { trusted: boolean }).trusted).toBe(true);
    expect(String(out)).toBe('<b>x</b>');
    expect(created).toEqual(['dompurify']);
  });

  it('escapes the input outside a DOM', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const fresh = await import('../../src/security/index.ts');
    expect(fresh.sanitizeHtml('<b onclick="x">a & b</b>')).toBe('&lt;b onclick=&quot;x&quot;&gt;a &amp; b&lt;/b&gt;');
  });
});

describe('isAllowedOrigin', () => {
  beforeEach(() => vi.stubGlobal('location', new URL('https://app.bcbpsolutions.com/t/acme/')));

  it.each([
    ['/api/x', [], true],
    ['https://app.bcbpsolutions.com/remotes/x.js', [], true],
    ['https://cdn.bcbpsolutions.com/x.js', ['https://cdn.bcbpsolutions.com'], true],
    ['https://cdn.bcbpsolutions.com:8443/x.js', ['https://cdn.bcbpsolutions.com'], false],
    ['http://app.bcbpsolutions.com/x', [], false],
    ['https://evil.example/x', ['https://cdn.bcbpsolutions.com'], false],
    ['//evil.example/x', [], false],
    ['javascript:alert(1)', [], false],
    ['data:text/javascript,1', [], false],
    ['http://[bad', [], false],
  ])('%s with %j → %s', (url, allow, expected) => {
    expect(isAllowedOrigin(url, allow)).toBe(expected);
  });
});

describe('installTrustedTypesPolicy', () => {
  type Rules = {
    createHTML: (s: string) => string;
    createScriptURL: (s: string) => string;
    createScript: (s: string) => string;
  };
  let policies: Record<string, Rules>;

  beforeEach(() => {
    policies = {};
    vi.stubGlobal('location', new URL('https://app.bcbpsolutions.com/'));
    vi.stubGlobal('trustedTypes', {
      createPolicy: (name: string, rules: Rules) => {
        if (policies[name]) throw new TypeError(`policy ${name} exists`);
        policies[name] = rules;
        return { name };
      },
    });
  });

  it("creates 'platform-sdk' once", () => {
    installTrustedTypesPolicy();
    installTrustedTypesPolicy();
    expect(Object.keys(policies)).toEqual(['platform-sdk']);
    expect(getRuntime().trustedTypesPolicy).toEqual({ name: 'platform-sdk' });
  });

  it('sanitises HTML, never creates scripts, and allows script URLs from the page or configured remote origins', () => {
    getRuntime().config = { remotes: { allowedOrigins: ['https://cdn.bcbpsolutions.com'] } };
    installTrustedTypesPolicy();
    const p = policies['platform-sdk']!;
    expect(p.createHTML('<img src="/x.png" onerror=alert(1)>')).toBe('<img src="/x.png">');
    expect(() => p.createScript('alert(1)')).toThrow(TypeError);
    expect(p.createScriptURL('/remotes/tenders/1.0.0/remoteEntry.js')).toBe('https://app.bcbpsolutions.com/remotes/tenders/1.0.0/remoteEntry.js');
    expect(p.createScriptURL('https://cdn.bcbpsolutions.com/r.js')).toBe('https://cdn.bcbpsolutions.com/r.js');
    expect(() => p.createScriptURL('https://evil.example/r.js')).toThrow(TypeError);
  });

  it('is a no-op without Trusted Types', () => {
    vi.stubGlobal('trustedTypes', undefined);
    expect(() => installTrustedTypesPolicy()).not.toThrow();
    expect(getRuntime().trustedTypesPolicy).toBeUndefined();
  });
});
