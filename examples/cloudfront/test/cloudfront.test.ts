import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module
import { buildCsp, securityHeaders, TRUSTED_TYPES_POLICIES } from '../csp.mjs';
// @ts-expect-error plain JS module
import { cleanUri, handler, normalise, originVerified } from '../csp-report/handler.mjs';
import { platformWebpackConfig } from '../../../packages/webpack-preset/src/index.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('CSP and response headers (§C3)', () => {
  it('is exactly the design doc header', () => {
    const doc = read('../../../docs/design/frontend-sdk-design.md');
    const block = doc.slice(doc.indexOf('Content-Security-Policy:\n'), doc.indexOf('Reporting-Endpoints:'));
    const text = block.replace('Content-Security-Policy:', '').replace(/\s+/g, ' ').trim();
    expect(buildCsp()).toBe(text);
  });

  it('falls back to report-uri for browsers without Reporting-API CSP reports', () => {
    expect(buildCsp()).toMatch(/; report-uri \/csp-report; report-to csp$/);
    expect(securityHeaders()['Reporting-Endpoints']).toBe('csp="/csp-report"');
  });

  it('names the Trusted Types policies the SDK, the preset and DOMPurify create', () => {
    const security = read('../../../packages/frontend-sdk/src/security/index.ts');
    expect(security).toContain("'platform-sdk'");
    expect(platformWebpackConfig({ role: 'shell', mode: 'production' }).output?.trustedTypes).toEqual({ policyName: 'platform-webpack' });
    expect(TRUSTED_TYPES_POLICIES).toEqual(['platform-sdk', 'platform-webpack', 'dompurify']);
  });

  it('response-headers-policy.json carries the same values', () => {
    const policy = JSON.parse(read('../response-headers-policy.json'));
    const headers = securityHeaders();
    expect(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy).toBe(headers['Content-Security-Policy']);
    const custom = Object.fromEntries(policy.CustomHeadersConfig.Items.map((i: { Header: string; Value: string }) => [i.Header, i.Value]));
    for (const h of ['Reporting-Endpoints', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy']) expect(custom[h]).toBe(headers[h]);
    expect(policy.CustomHeadersConfig.Quantity).toBe(policy.CustomHeadersConfig.Items.length);
  });

  it('refuses a non-https or non-origin IdP', () => {
    expect(() => buildCsp({ idpOrigin: 'http://auth.example.com' })).toThrow(TypeError);
    expect(() => buildCsp({ idpOrigin: 'https://auth.example.com/realms' })).toThrow(TypeError);
    expect(buildCsp({ idpOrigin: 'https://auth.example.com' })).toContain("connect-src 'self' https://auth.example.com;");
  });

  it('defaults allow nothing beyond self and the IdP', () => {
    const csp = buildCsp();
    expect(csp).toContain("; script-src 'self';");
    expect(csp).toContain("; connect-src 'self' https://auth.bcbpsolutions.com;");
    expect(buildCsp({ remoteOrigins: [], apiOrigins: [] })).toBe(csp);
  });

  it('adds runtime.json remote origins to script-, style-, img-, font- and connect-src, API origins to connect-src', () => {
    const csp = buildCsp({
      remoteOrigins: ['https://cdn.example.com', 'https://remotes.example.com:8443'],
      apiOrigins: ['https://api.example.com', 'https://cdn.example.com'],
    });
    expect(csp).toContain("; script-src 'self' https://cdn.example.com https://remotes.example.com:8443;");
    expect(csp).toContain("; connect-src 'self' https://auth.bcbpsolutions.com https://cdn.example.com https://remotes.example.com:8443 https://api.example.com;");
    // A remote's static CSS, images and fonts come from its own origin too (zero-runtime CSS, §D3).
    expect(csp).toContain("; style-src 'self' https://cdn.example.com https://remotes.example.com:8443;");
    expect(csp).toContain("; img-src 'self' data: https://cdn.example.com https://remotes.example.com:8443;");
    expect(csp).toContain("; font-src 'self' https://cdn.example.com https://remotes.example.com:8443;");
    expect(buildCsp({ apiOrigins: ['https://api.example.com'] })).toContain("; style-src 'self';"); // API origins serve no assets
  });

  it.each([
    ['https://*.example.com'],
    ['https://cdn.example.com/'],
    ['https://cdn.example.com/remotes'],
    ['http://cdn.example.com'],
    ['http://localhost:3001'],
    ['cdn.example.com'],
    ['*'],
    ["'unsafe-inline'"],
    ['https://cdn.example.com https://evil.example'],
  ])('rejects %s as a remote or API origin', (bad) => {
    expect(() => buildCsp({ remoteOrigins: [bad] })).toThrow(TypeError);
    expect(() => buildCsp({ apiOrigins: [bad] })).toThrow(TypeError);
  });

  it('rejects a non-array origin list', () => {
    expect(() => buildCsp({ remoteOrigins: 'https://cdn.example.com' })).toThrow(TypeError);
  });
});

describe('spa-rewrite CloudFront Function', () => {
  const run = (uri: string) => {
    const ctx: { handler?: (e: unknown) => { uri: string } } = {};
    runInNewContext(`${read('../spa-rewrite.js')}\nthis.handler = handler;`, ctx);
    return ctx.handler!({ request: { uri, headers: {} } }).uri;
  };

  it.each([
    ['/', '/index.html'],
    ['/t/acme/tenders/42/edit', '/index.html'],
    ['/auth/callback', '/index.html'],
    ['/favicon.ico', '/favicon.ico'],
    ['/main.3f2a.js', '/main.3f2a.js'],
    ['/api/v1/tenders', '/api/v1/tenders'],
    ['/api/v1/me/session-context', '/api/v1/me/session-context'],
    ['/otel/v1/logs', '/otel/v1/logs'],
    ['/csp-report', '/csp-report'],
    ['/remotes/tenders/1.0.0/remoteEntry.js', '/remotes/tenders/1.0.0/remoteEntry.js'],
  ])('%s → %s', (uri, want) => {
    expect(run(uri)).toBe(want);
  });
});

describe('/csp-report Lambda', () => {
  const SECRET = 'current-0123456789abcdef';
  const post = (body: unknown, type = 'application/reports+json', verify: string | null = SECRET) => ({
    requestContext: { http: { method: 'POST' } },
    headers: { 'content-type': type, ...(verify === null ? {} : { 'x-origin-verify': verify }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  });
  const env = {
    COLLECTOR_LOGS_URL: 'http://collector:4318/v1/logs',
    SERVICE_NAMESPACE: 'portal',
    DEPLOYMENT_ENVIRONMENT: 'staging',
    ORIGIN_VERIFY_SECRET: `${SECRET}, previous-fedcba9876543210`,
  };
  const report = { 'csp-report': { 'blocked-uri': 'inline', 'violated-directive': 'script-src' } };

  describe('origin verification (CloudFront custom origin header, not OAC)', () => {
    it.each([
      ['missing', null],
      ['empty', ''],
      ['wrong', 'current-0123456789abcdeX'],
      ['a prefix of the secret', 'current'],
      ['the whole comma-separated list', env.ORIGIN_VERIFY_SECRET],
    ])('a %s x-origin-verify header is a 403 with no body, and nothing is forwarded', async (_, verify) => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      const res = await handler(post(report, 'application/csp-report', verify), { fetch, env });
      expect(res).toEqual({ statusCode: 403, headers: { 'cache-control': 'no-store' }, body: '' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects before method and content-type checks', async () => {
      const event = { ...post('x', 'text/plain', 'nope'), requestContext: { http: { method: 'GET' } } };
      expect((await handler(event, { fetch: vi.fn(), env })).statusCode).toBe(403);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['only separators', ' , '],
    ])('fails closed when ORIGIN_VERIFY_SECRET is %s', async (_, secret) => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      const res = await handler(post(report, 'application/csp-report', ''), { fetch, env: { ...env, ORIGIN_VERIFY_SECRET: secret } });
      expect(res.statusCode).toBe(403);
      const res2 = await handler(post(report, 'application/csp-report', SECRET), { fetch, env: { ...env, ORIGIN_VERIFY_SECRET: secret } });
      expect(res2.statusCode).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['current', SECRET],
      ['previous (rotation)', 'previous-fedcba9876543210'],
    ])('the %s secret is processed', async (_, verify) => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      expect((await handler(post(report, 'application/csp-report', verify), { fetch, env })).statusCode).toBe(204);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('originVerified compares exactly', () => {
      expect(originVerified('a', 'a')).toBe(true);
      expect(originVerified('a', 'b,a')).toBe(true);
      expect(originVerified('a ', 'a')).toBe(false);
      expect(originVerified(undefined, 'a')).toBe(false);
      expect(originVerified('a', undefined)).toBe(false);
    });
  });

  it('accepts application/csp-report (report-uri) and application/reports+json (report-to)', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    expect((await handler(post(report, 'application/csp-report'), { fetch, env })).statusCode).toBe(204);
    const api = [{ type: 'csp-violation', body: { blockedURL: 'inline', effectiveDirective: 'script-src-elem' } }];
    expect((await handler(post(api, 'application/reports+json; charset=utf-8'), { fetch, env })).statusCode).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cleanUri keeps origin and path or the keyword, never a query or credentials', () => {
    expect(cleanUri('https://evil.example/x.js?token=abc#frag')).toBe('https://evil.example/x.js');
    expect(cleanUri('https://user:pass@cdn.example/a')).toBe('https://cdn.example/a');
    expect(cleanUri('inline')).toBe('inline');
    expect(cleanUri('data:text/javascript,alert(1)')).toBe('data');
    expect(cleanUri('not a url')).toBe('other');
  });

  it('reads both report formats', () => {
    const api = normalise({ type: 'csp-violation', body: { documentURL: 'https://app.example/t/acme/?q=1', blockedURL: 'eval', effectiveDirective: 'script-src', disposition: 'enforce' } });
    const legacy = normalise({ 'csp-report': { 'document-uri': 'https://app.example/x', 'blocked-uri': 'https://cdn.example/a.css?v=1', 'violated-directive': 'style-src' } });
    expect(api).toMatchObject({ directive: 'script-src', blocked: 'eval', document: 'https://app.example/t/acme/' });
    expect(legacy).toMatchObject({ directive: 'style-src', blocked: 'https://cdn.example/a.css', disposition: 'enforce' });
    expect(normalise({ type: 'deprecation', body: {} })).toBeUndefined();
  });

  it('forwards violations to the collector as OTLP logs, redacted', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const res = await handler(
      post([
        { type: 'csp-violation', body: { documentURL: 'https://app.example/t/acme/?session=s3cr3t', blockedURL: 'https://evil.example/x.js?token=abc', effectiveDirective: 'script-src-elem', sourceFile: 'https://app.example/main.js', lineNumber: 12 } },
        { type: 'network-error', body: {} },
      ]),
      { fetch, env },
    );
    expect(res.statusCode).toBe(204);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.COLLECTOR_LOGS_URL);
    const body = JSON.parse(String(init.body));
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    const attrs = Object.fromEntries(records[0].attributes.map((a: { key: string; value: Record<string, string> }) => [a.key, Object.values(a.value)[0]]));
    expect(attrs).toMatchObject({ 'event.name': 'csp.violation', 'csp.blocked_uri': 'https://evil.example/x.js', 'csp.document_uri': 'https://app.example/t/acme/', 'csp.line_number': '12' });
    expect(String(init.body)).not.toMatch(/s3cr3t|token=abc/);
    expect(body.resourceLogs[0].resource.attributes).toContainEqual({ key: 'service.namespace', value: { stringValue: 'portal' } });
  });

  it.each([
    [{ ...post({}), requestContext: { http: { method: 'GET' } } }, 405],
    [post({}, 'text/plain'), 415],
    [post('x'.repeat(64 * 1024 + 1)), 413],
    [post('{not json'), 400],
    [post([{ type: 'deprecation', body: {} }]), 204],
  ])('answers %#: %s', async (event, status) => {
    expect((await handler(event, { fetch: vi.fn(), env })).statusCode).toBe(status);
  });

  it('a collector failure is a 502; no collector configured is a 503', async () => {
    const event = post(report, 'application/csp-report');
    expect((await handler(event, { fetch: vi.fn(async () => new Response(null, { status: 500 })), env })).statusCode).toBe(502);
    expect((await handler(event, { fetch: vi.fn(async () => Promise.reject(new Error('down'))), env })).statusCode).toBe(502);
    expect((await handler(event, { fetch: vi.fn(), env: { ORIGIN_VERIFY_SECRET: SECRET } })).statusCode).toBe(503);
  });
});
