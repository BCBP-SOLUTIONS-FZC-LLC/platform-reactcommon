// Smoke tests of the web distribution (examples/cloudfront/README.md, design doc §C3), as
// platform-gincommon's test/smoke: in-process by default, against the built examples served by
// ./cloudfront-stand-in.ts; with SMOKE_BASE_URL set, the same assertions against that deployment,
// read-only (GET only, no local server).
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module
import { securityHeaders } from '../../examples/cloudfront/csp.mjs';
import { RuntimeConfigError, setRuntimeConfig, tryGetConfig } from '../../packages/frontend-sdk/src/config/index.ts';
import { initializeCore } from '../../packages/frontend-sdk/src/core/index.ts';
import { loadManifest } from '../../packages/frontend-sdk/src/mfe/index.ts';
import { testenv } from '../testenv/index.ts';
import { missingBuildOutputs, startCloudFrontStandIn } from './cloudfront-stand-in.ts';

const live = testenv.smokeBaseUrl;
const mode = live ? `live (${live})` : 'in-process';
let base = '';
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (live) {
    base = new URL(live).origin;
    return;
  }
  const missing = missingBuildOutputs();
  if (missing.length > 0) throw new Error(`smoke (in-process) needs the built examples: run \`pnpm build\` first. Missing: ${missing.join(', ')}`);
  ({ baseUrl: base, close } = await startCloudFrontStandIn());
});
afterAll(async () => close?.());
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fetched {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
  text: string;
}

/** GET `path` (resolved against `from`, default the base URL); never follows redirects. */
async function get(path: string, from: string = base): Promise<Fetched> {
  const url = new URL(path, from).href;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch (cause) {
    throw new Error(`GET ${url} failed: ${String((cause as Error)?.cause ?? cause)}`, { cause });
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { url, status: res.status, headers: res.headers, body, text: body.toString('utf8') };
}

const where = (r: Fetched, what = '') => `GET ${r.url}${what ? `: ${what}` : ''}`;
const contentType = (r: Fetched) => r.headers.get('content-type') ?? '';
const JS = /^(text|application)\/(javascript|ecmascript|x-javascript)\b/i;
const JSON_TYPE = /^application\/([a-z.+-]*\+)?json\b/i;

function json(r: Fetched): unknown {
  try {
    return JSON.parse(r.text) as unknown;
  } catch {
    throw new Error(`${where(r)} is not JSON: ${r.text.slice(0, 200)}`);
  }
}

/** The CSP as directive → values (names lower-cased). */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** The response headers policy of §C3: exactly securityHeaders() in-process, its essentials live. */
function expectSecurityHeaders(r: Fetched): void {
  const h = (n: string) => r.headers.get(n);
  if (!live) {
    for (const [name, value] of Object.entries(securityHeaders() as Record<string, string>)) expect(h(name), where(r, name)).toBe(value);
  }
  const csp = h('content-security-policy');
  expect(csp, where(r, 'Content-Security-Policy (enforced, not Report-Only)')).toBeTruthy();
  const d = directives(csp!);
  const script = d.get('script-src') ?? d.get('default-src');
  expect(script, where(r, 'CSP script-src (or default-src)')).toBeDefined();
  expect(script, where(r, 'CSP script-src')).not.toContain("'unsafe-inline'");
  expect(script, where(r, 'CSP script-src')).not.toContain("'unsafe-eval'");
  expect(d.get('require-trusted-types-for'), where(r, 'CSP require-trusted-types-for')).toEqual(["'script'"]);
  expect(d.get('frame-ancestors'), where(r, 'CSP frame-ancestors')).toEqual(["'none'"]);
  expect(d.get('object-src'), where(r, 'CSP object-src')).toEqual(["'none'"]);
  expect(d.has('report-uri') || d.has('report-to'), where(r, 'CSP report-uri / report-to')).toBe(true);
  const hsts = /max-age=(\d+)/i.exec(h('strict-transport-security') ?? '');
  expect(Number(hsts?.[1] ?? 0), where(r, 'Strict-Transport-Security max-age (≥ 1 year)')).toBeGreaterThanOrEqual(31_536_000);
  expect(h('x-content-type-options'), where(r, 'X-Content-Type-Options')).toBe('nosniff');
  expect(h('referrer-policy'), where(r, 'Referrer-Policy')).toMatch(/^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/);
  expect(h('cross-origin-opener-policy'), where(r, 'Cross-Origin-Opener-Policy')).toBe('same-origin');
}

function expectNoCache(r: Fetched): void {
  expect(r.headers.get('cache-control') ?? '', where(r, 'Cache-Control')).toMatch(/\bno-(cache|store)\b/);
}

/** The src of every <script> in `html`; fails on an inline script (CSP script-src 'self'). */
function scriptSources(r: Fetched): string[] {
  const srcs: string[] = [];
  for (const [, attrs = '', body = ''] of r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    expect(body.trim(), where(r, `inline script <script${attrs}>`)).toBe('');
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    expect(src, where(r, `<script${attrs}> has no src`)).not.toBeNull();
    srcs.push(src![1] ?? src![2] ?? src![3]!);
  }
  return srcs;
}

let identityReady = false;

/** The page identity from testenv (so the localhost-origin rule follows ENVIRONMENT), set once. */
function ensureIdentity(): void {
  if (identityReady) return;
  initializeCore({ serviceName: 'smoke', domain: testenv.domain, environment: testenv.environment });
  identityReady = true;
}

/** /config/runtime.json validated by the SDK (schema and environment rules) and set as the page config. */
async function ensureConfig(): Promise<void> {
  if (tryGetConfig()) return;
  ensureIdentity();
  const r = await get('/config/runtime.json');
  expect(r.status, where(r)).toBe(200);
  try {
    setRuntimeConfig(json(r) as Parameters<typeof setRuntimeConfig>[0]);
  } catch (e) {
    if (e instanceof RuntimeConfigError) throw new Error(`${where(r)} fails the SDK's validation: ${e.message}`, { cause: e });
    throw e;
  }
}

describe(`web distribution smoke (${mode})`, () => {
  describe('the shell document', () => {
    it('GET / is the shell index.html, with no inline script, style or event handler', async () => {
      const r = await get('/');
      expect(r.status, where(r)).toBe(200);
      expect(contentType(r), where(r, 'Content-Type')).toMatch(/^text\/html\b/i);
      expect(r.text, where(r)).toMatch(/<div id=["']?root\b/);
      expect(scriptSources(r).length, where(r, 'external scripts')).toBeGreaterThan(0);
      expect(r.text, where(r, 'inline <style> (style-src self)')).not.toMatch(/<style\b/i);
      expect(r.text, where(r, 'inline style attribute (style-src self)')).not.toMatch(/<[^>]+\sstyle\s*=/i);
      expect(r.text, where(r, 'inline event handler attribute')).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    });

    it.each(['/', '/t/acme/tenders', '/config/runtime.json', '/remotes/manifest.json'])('GET %s carries the security headers', async (path) => {
      const r = await get(path);
      expect(r.status, where(r)).toBe(200);
      expectSecurityHeaders(r);
    });

    it.each(['/t/acme/tenders', '/t/acme/tenders/42/edit', '/auth/callback', '/t/acme/tenders/RFQ-2026.01'])('the deep link %s is index.html (SPA rewrite)', async (path) => {
      const [index, r] = [await get('/'), await get(path)];
      expect(r.status, where(r)).toBe(200);
      expect(contentType(r), where(r, 'Content-Type')).toMatch(/^text\/html\b/i);
      expect(r.text, where(r, 'body equals GET /')).toBe(index.text);
    });

    it.each(['/', '/t/acme/tenders/42/edit', '/auth/callback'])("index.html's scripts load from %s", async (page) => {
      const doc = await get(page);
      for (const src of scriptSources(doc)) {
        const r = await get(src, doc.url);
        expect(new URL(r.url).origin, `${where(doc)}: <script src=${src}> is not same-origin`).toBe(new URL(base).origin);
        expect(r.status, `${where(doc)}: <script src=${src}> → ${where(r)}`).toBe(200);
        expect(contentType(r), `${where(doc)}: <script src=${src}> → ${where(r, 'Content-Type')}`).toMatch(JS);
      }
    });

    it('a missing file is an error, not index.html (no custom 403/404 → index.html)', async () => {
      const r = await get('/missing.0123456789abcdef.js');
      expect(r.status, where(r)).toBeGreaterThanOrEqual(400);
      expect(contentType(r), where(r, 'Content-Type')).not.toMatch(/^text\/html\b/i);
    });
  });

  describe('/api/*', () => {
    it('an unknown API path answers the gateway, never the SPA index.html', async () => {
      const r = await get('/api/does-not-exist');
      expect(r.status, where(r)).toBeGreaterThanOrEqual(400);
      expect(contentType(r), where(r, 'Content-Type')).not.toMatch(/^text\/html\b/i);
      expect(r.text, where(r)).not.toMatch(/<div id=["']?root\b/);
      if (!live) {
        expect(r.status, where(r)).toBe(404);
        expect(contentType(r), where(r, 'Content-Type')).toMatch(/^application\/problem\+json\b/);
        expect(json(r), where(r)).toMatchObject({ status: 404 });
      }
    });
  });

  describe('/config/runtime.json', () => {
    it('is served uncached and passes the SDK runtime-config validation', async () => {
      const r = await get('/config/runtime.json');
      expect(r.status, where(r)).toBe(200);
      expect(contentType(r), where(r, 'Content-Type')).toMatch(JSON_TYPE);
      expectNoCache(r);
      await ensureConfig();
      expect(tryGetConfig(), where(r)).toBeDefined();
    });
  });

  describe('/version.json', () => {
    it('when deployed, is uncached and names the shell version', async (ctx) => {
      const r = await get('/version.json');
      if (live && (r.status === 403 || r.status === 404)) ctx.skip();
      expect(r.status, where(r)).toBe(200);
      expect(contentType(r), where(r, 'Content-Type')).toMatch(JSON_TYPE);
      expectNoCache(r);
      const v = json(r) as { version?: unknown };
      expect(typeof v.version === 'string' && v.version.length > 0, `${where(r)}: { "version": "…" }, got ${r.text.slice(0, 200)}`).toBe(true);
    });
  });

  describe('/remotes', () => {
    it('manifest.json is uncached, every entry passes loadManifest, and each remoteEntry.js loads', async () => {
      const r = await get('/remotes/manifest.json');
      expect(r.status, where(r)).toBe(200);
      expect(contentType(r), where(r, 'Content-Type')).toMatch(JSON_TYPE);
      expectNoCache(r);
      const raw = json(r);
      expect(typeof raw === 'object' && raw !== null && !Array.isArray(raw), `${where(r)} is a JSON object of remotes`).toBe(true);

      // loadManifest checks entries against the page's origin and the config's remotes.allowedOrigins.
      await ensureConfig();
      const page = new URL('/', base);
      vi.stubGlobal('location', { href: page.href, origin: page.origin });
      const manifest = await loadManifest(r.url);
      const dropped = Object.keys(raw as object).filter((name) => !(name in manifest));
      expect(dropped, `${where(r)}: remotes loadManifest drops (invalid name, entry, version, ownerDomain or integrity)`).toEqual([]);

      for (const [name, e] of Object.entries(manifest)) {
        const entry = await get(e.entry);
        expect(entry.status, `${name}: ${where(entry)}`).toBe(200);
        expect(contentType(entry), `${name}: ${where(entry, 'Content-Type')}`).toMatch(JS);
        if (e.integrity) {
          const [alg, expected] = [e.integrity.slice(0, 6), e.integrity.slice(7)];
          const actual = createHash(alg).update(entry.body).digest('base64');
          expect(actual, `${name}: ${where(entry)} does not match the manifest's integrity ${e.integrity}`).toBe(expected);
        }
      }
    });
  });
});
