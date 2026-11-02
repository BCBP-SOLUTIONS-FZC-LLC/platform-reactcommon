// @vitest-environment jsdom
// jsdom, not happy-dom: DOMPurify is tested against browsers and jsdom; happy-dom's parser lets a <script> through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntime, resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { installTrustedTypesPolicy, isAllowedOrigin, sanitizeHtml } from '../../../packages/frontend-sdk/src/security/index.ts';
import { withoutReportedMarkup } from '../../../packages/frontend-sdk/src/security/markup.ts';

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
    const fresh = await import('../../../packages/frontend-sdk/src/security/index.ts');
    const out = fresh.sanitizeHtml('<b onclick="x()">x</b>');
    expect(typeof out).not.toBe('string');
    expect((out as unknown as { trusted: boolean }).trusted).toBe(true);
    expect(String(out)).toBe('<b>x</b>');
    expect(created).toEqual(['dompurify']);
  });

  it('escapes the input outside a DOM', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const fresh = await import('../../../packages/frontend-sdk/src/security/index.ts');
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

describe('without a usable DOM', () => {
  it('escapes, in sanitizeHtml and the platform-sdk policy, when DOMPurify is unsupported', async () => {
    vi.stubGlobal('window', {}); // a window without a document: DOMPurify reports isSupported false
    vi.stubGlobal('location', new URL('https://app.bcbpsolutions.com/'));
    let rules: { createHTML: (s: string) => string; createScriptURL: (s: string) => string } | undefined;
    vi.stubGlobal('trustedTypes', {
      createPolicy: (_name: string, r: typeof rules) => {
        rules = r;
        return {};
      },
    });
    vi.resetModules();
    const fresh = await import('../../../packages/frontend-sdk/src/security/index.ts');
    const rt = await import('../../../packages/frontend-sdk/src/internal/runtime.ts');
    rt.resetRuntimeForTests();
    expect(fresh.sanitizeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    fresh.installTrustedTypesPolicy();
    expect(rules!.createHTML("<script>alert('x')</script>")).toBe('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    // no runtime config: only the page's own origin is an allowed script origin
    expect(() => rules!.createScriptURL('https://cdn.bcbpsolutions.com/r.js')).toThrow(TypeError);
    expect(rules!.createScriptURL('/r.js')).toBe('https://app.bcbpsolutions.com/r.js');
  });

  it('treats a non-string input as text', () => {
    expect(String(sanitizeHtml(undefined as never))).toBe('');
    expect(String(sanitizeHtml(42 as never))).toBe('42');
  });
});

// Known browser bug 3: Chromium reports (and POSTs to /csp-report) every event-handler and style
// attribute in the input DOMPurify parses, under the page CSP. The pre-pass removes them first.
describe('sanitizeHtml pre-pass (withoutReportedMarkup)', () => {
  it.each([
    ['<p onclick="alert(1)">Hello <span style="color:red">styled</span><img src=x onerror="alert(2)"></p>', '<p>Hello <span>styled</span><img src=x></p>'],
    ['<p/onclick=alert(1)>slash</p>', '<p>slash</p>'],
    ['<P ONCLICK="x">upper</P>', '<P>upper</P>'],
    ['<a title="a>b" onmouseover=\'x\' href="/x">gt</a>', '<a title="a>b" href="/x">gt</a>'],
    ['<img src=x onerror=alert(1)//>', '<img src=x>'],
    ['<div style=color:red>unquoted</div>', '<div>unquoted</div>'],
    ['<style>p{color:red}</style><p>after</p>', '<p>after</p>'],
    ['<STYLE type="text/css">x</STYLE >y', 'y'],
  ])('removes what Chromium reports while parsing: %s', (dirty, want) => {
    expect(withoutReportedMarkup(dirty)).toBe(want);
  });

  it.each([
    'text onclick="x" stays text',
    '<p data-x="1" title="onclick=still a value" class="online">kept</p>',
    'a < b and c > d',
    '<a href="/onboarding">onboarding</a>',
  ])('leaves text and other attributes alone: %s', (s) => {
    expect(withoutReportedMarkup(s)).toBe(s);
  });

  it('does not change what sanitizeHtml returns for hostile input', () => {
    const corpus: [string, string][] = [
      ['<p onclick="alert(1)">Hello <span style="color:red">styled</span><img src=x onerror="alert(2)"></p>', '<p>Hello <span>styled</span><img></p>'], // src="x" fails SAFE_LINK
      ['<p/onclick=alert(1)>a</p><script>alert(1)</script>', '<p>a</p>'],
      ['<style>*{x:y}</style><b>bold</b>', '<b>bold</b>'],
      ['<a href="javascript:alert(1)" onclick="x">link</a>', 'link'],
    ];
    for (const [dirty, want] of corpus) expect(String(sanitizeHtml(dirty)), dirty).toBe(want);
  });
});

describe('sanitizeHtml pre-pass: linear time and no change to the sanitised output', () => {
  it.each([
    ['unclosed tags', '<a b '.repeat(40_000)],
    ['unquoted values full of slashes', `<a x=${'/y'.repeat(100_000)}`],
    ['attributes without a closing >', `<a${' b'.repeat(100_000)}`],
    ['many <style> openings', '<style>'.repeat(30_000)],
    ['handlers everywhere', '<p onclick=x style=y>t</p>'.repeat(8_000)],
  ])('%s (about 200 KB) in well under a second', (_n, input) => {
    const t = performance.now();
    withoutReportedMarkup(input);
    expect(performance.now() - t).toBeLessThan(500); // the regex version took 12 s on half of this
  });

  it('for 2000 generated inputs, sanitizeHtml returns exactly what DOMPurify returns without the pre-pass', async () => {
    const { default: createDOMPurify } = await import('../../../packages/frontend-sdk/node_modules/dompurify/dist/purify.es.mjs');
    const reference = createDOMPurify(window);
    reference.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) node.setAttribute('rel', 'noopener noreferrer');
    });
    const config = {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'template', 'base', 'link', 'meta', 'a'],
      FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'target'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/))/i,
      ALLOW_DATA_ATTR: false,
    };
    const pieces = ['<p', '<b', '<img', '<a', '<style>', '</style>', '<STYLE >', ' ', '/', '=', '"', "'", '>', 'onclick', 'ONLOAD', 'style', 'title', 'href', 'src', 'x', '/y', 'alert(1)', 'a>b', '</p>', '</b>', 'text', '<!--', '-->', '&amp;', '\n'];
    let seed = 42;
    const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % k);
    for (let n = 0; n < 2000; n++) {
      let s = '';
      for (let p = 0, len = 1 + rnd(25); p < len; p++) s += pieces[rnd(pieces.length)];
      expect(String(sanitizeHtml(s)), s).toBe(String(reference.sanitize(s, config)));
    }
  });
});
