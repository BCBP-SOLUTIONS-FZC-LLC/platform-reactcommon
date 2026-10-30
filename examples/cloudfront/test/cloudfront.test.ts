import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module
import { buildCsp, securityHeaders, TRUSTED_TYPES_POLICIES } from '../csp.mjs';
// @ts-expect-error plain JS module
import { cleanUri, handler, normalise } from '../csp-report/handler.mjs';
import { platformWebpackConfig } from '../../../packages/webpack-preset/src/index.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('CSP and response headers (§C3)', () => {
  it('is exactly the design doc header', () => {
    const doc = read('../../../docs/design/frontend-sdk-design.md');
    const block = doc.slice(doc.indexOf('Content-Security-Policy:\n'), doc.indexOf('Reporting-Endpoints:'));
    const text = block.replace('Content-Security-Policy:', '').replace(/\s+/g, ' ').trim();
    expect(buildCsp()).toBe(text);
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
  const post = (body: unknown, type = 'application/reports+json') => ({
    requestContext: { http: { method: 'POST' } },
    headers: { 'content-type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  });
  const env = { COLLECTOR_LOGS_URL: 'http://collector:4318/v1/logs', SERVICE_NAMESPACE: 'portal', DEPLOYMENT_ENVIRONMENT: 'staging' };

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
    const report = post({ 'csp-report': { 'blocked-uri': 'inline', 'violated-directive': 'script-src' } }, 'application/csp-report');
    expect((await handler(report, { fetch: vi.fn(async () => new Response(null, { status: 500 })), env })).statusCode).toBe(502);
    expect((await handler(report, { fetch: vi.fn(async () => Promise.reject(new Error('down'))), env })).statusCode).toBe(502);
    expect((await handler(report, { fetch: vi.fn(), env: {} })).statusCode).toBe(503);
  });
});
