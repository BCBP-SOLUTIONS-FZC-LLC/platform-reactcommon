// Helpers for test/stack/e2e.spec.ts: the shell's sign-in flow through the real Keycloak login form,
// what the page sent and received, and the evidence the stack writes (Collector JSON lines, the edge log,
// Envoy's access log, Keycloak's admin API).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type Request, type Response, test } from '@playwright/test';
import { STACK } from './stack-constants.ts';

export const STATE = join(import.meta.dirname, '..', '..', '.state');
export type StackUser = (typeof STACK.users)[keyof typeof STACK.users];

/** SDK storage keys (packages/frontend-sdk/src/auth/oidc.ts). */
export const SIGNED_OUT_KEY = '@platform/frontend-sdk:auth:signed-out';
export const LAST_USER_KEY = '@platform/frontend-sdk:auth:last-user';

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  error?: string;
}

export interface ApiCall { url: URL; status: number; request: Request; response: Response; text: string; json: () => unknown }

/** Everything the page exchanged with the IdP and the gateway, in order. */
export class Traffic {
  readonly tokenCalls: { grant: string; status: number; body: TokenResponse }[] = [];
  readonly authorize: URL[] = [];
  readonly api: ApiCall[] = [];
  readonly csp: string[] = [];

  constructor(readonly page: Page) {
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.host === new URL(STACK.authOrigin).host && u.pathname.endsWith('/protocol/openid-connect/auth')) this.authorize.push(u);
    });
    page.on('response', async (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/protocol/openid-connect/token') && r.request().method() === 'POST') {
        const grant = new URLSearchParams(r.request().postData() ?? '').get('grant_type') ?? '';
        const body = (await r.json().catch(() => ({}))) as TokenResponse;
        this.tokenCalls.push({ grant, status: r.status(), body });
      } else if (u.host === new URL(STACK.appOrigin).host && u.pathname.startsWith('/api/')) {
        // Read the body now: after a navigation it is gone.
        const text = await r.text().catch(() => '');
        this.api.push({ url: u, status: r.status(), request: r.request(), response: r, text, json: () => JSON.parse(text) as unknown });
      }
    });
    page.on('console', (m) => {
      if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text())) this.csp.push(m.text());
    });
  }

  /** The newest successful token response (code exchange or refresh). */
  latestTokens(): TokenResponse {
    const ok = this.tokenCalls.filter((c) => c.status === 200);
    if (ok.length === 0) throw new Error('no token response seen');
    return ok[ok.length - 1]!.body;
  }

  apiCall(path: string): ApiCall | undefined {
    return this.api.find((a) => a.url.pathname === path);
  }
}

/** Records securitypolicyviolation events in the page (init script: not subject to the page CSP). */
export async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: { directive: string; blocked: string }[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
  });
}

export async function cspViolations(page: Page): Promise<{ directive: string; blocked: string }[]> {
  return page.evaluate(() => (window as unknown as { __csp?: { directive: string; blocked: string }[] }).__csp ?? []);
}

/** Fills the real Keycloak login form (the page must be on it or heading there). */
export async function keycloakLogin(page: Page, user: StackUser): Promise<void> {
  await page.waitForURL((u) => u.host === new URL(STACK.authOrigin).host);
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
}

/** Anonymous → identifier-first screen → PUB-1 → Keycloak → callback → the shell renders the workspace. */
export async function signInFromScratch(page: Page, user: StackUser, identifier: string, slug = identifier): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Company workspace or invitation email').fill(identifier);
  await page.getByRole('button', { name: 'Continue' }).click();
  await keycloakLogin(page, user);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(slug);
}

export function decodeJwt(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Runs a test navigation (goto, reload) and runs it once more when one the app started itself (a
 * prompt=none round trip, a redirect after a refresh) interrupted it: Chromium, Firefox and WebKit word
 * that differently.
 */
export async function navigateOnce(page: Page, nav: () => Promise<unknown>): Promise<void> {
  try {
    await nav();
  } catch (e) {
    if (!/interrupted by another navigation|NS_BINDING_ABORTED|net::ERR_ABORTED|Frame load interrupted/.test(String(e))) throw e;
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await nav();
  }
}

/**
 * A full page load of a deep link in a signed-in tab. The SDK's prompt=none round trip comes back to it
 * (WebKit reports the goto as interrupted). Issue 19: a refresh in flight when the navigation starts is
 * aborted, and the old page's restore (prompt=none, back to the old URL) replaces the navigation; then
 * this records it and loads the deep link once more.
 */
export async function gotoDeepLink(page: Page, path: string): Promise<void> {
  const go = () =>
    page.goto(path, { waitUntil: 'commit' }).catch((e: Error) => {
      if (!/interrupted by another navigation|NS_BINDING_ABORTED/.test(e.message)) throw e;
    });
  await go();
  const arrived = await page.waitForURL((u) => u.pathname === path, { timeout: 15_000 }).then(() => true, () => false);
  if (arrived) return;
  test.info().annotations.push({ type: 'issue', description: `Issue 19: an aborted refresh's restore replaced the navigation to ${path} (landed on ${new URL(page.url()).pathname}); loaded it again` });
  await go();
  await page.waitForURL((u) => u.pathname === path);
}

/** Polls `fn` until it returns a value (not undefined/false) or the timeout passes. */
export async function eventually<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 30_000, what = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── Collector output (OTLP JSON lines written by the file exporters) ─────────────────────────────
type AnyValue = { stringValue?: string; intValue?: string; boolValue?: boolean };
type Attr = { key: string; value: AnyValue };
export interface Span { traceId: string; spanId: string; name: string; service: string; attributes: Record<string, string> }
export interface LogRecord { traceId?: string; service: string; body: string; severity?: string; attributes: Record<string, string> }

const attrs = (list: Attr[] | undefined): Record<string, string> =>
  Object.fromEntries((list ?? []).map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? String(a.value.boolValue ?? '')]));

function jsonl(file: string): unknown[] {
  const f = join(STATE, file);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as unknown];
    } catch {
      return [];
    }
  });
}

export function spans(): Span[] {
  const out: Span[] = [];
  for (const doc of jsonl('otel/traces.jsonl') as { resourceSpans?: { resource?: { attributes?: Attr[] }; scopeSpans?: { spans?: { traceId: string; spanId: string; name: string; attributes?: Attr[] }[] }[] }[] }[]) {
    for (const rs of doc.resourceSpans ?? []) {
      const service = attrs(rs.resource?.attributes)['service.name'] ?? '';
      for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push({ traceId: s.traceId, spanId: s.spanId, name: s.name, service, attributes: attrs(s.attributes) });
    }
  }
  return out;
}

export function logRecords(): LogRecord[] {
  const out: LogRecord[] = [];
  for (const doc of jsonl('otel/logs.jsonl') as { resourceLogs?: { resource?: { attributes?: Attr[] }; scopeLogs?: { logRecords?: { traceId?: string; body?: AnyValue; severityText?: string; attributes?: Attr[] }[] }[] }[] }[]) {
    for (const rl of doc.resourceLogs ?? []) {
      const service = attrs(rl.resource?.attributes)['service.name'] ?? '';
      for (const sl of rl.scopeLogs ?? []) {
        for (const r of sl.logRecords ?? []) {
          out.push({ ...(r.traceId ? { traceId: r.traceId } : {}), service, body: r.body?.stringValue ?? '', ...(r.severityText ? { severity: r.severityText } : {}), attributes: attrs(r.attributes) });
        }
      }
    }
  }
  return out;
}

/** The edge shim's request log. */
export function edgeLog(): { behavior?: string; method?: string; url?: string; status?: number; upstream?: string; rewrittenUri?: string; reqId?: string }[] {
  return jsonl('logs/edge.jsonl') as never;
}

// ── Container logs ─────────────────────────────────────────────────────────────────────────────
export function containerLog(service: string, sinceIso?: string): string {
  const args = ['logs', ...(sinceIso ? ['--since', sinceIso] : []), `${STACK.project}-${service}-1`];
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface EnvoyAccess { path: string; status: number; request_id: string; traceparent: string; upstream_x_tenant_id: string; upstream_x_user_id: string; upstream_x_tenant_roles: string; sub: string; details: string; response_content_type: string; client_ip: string; xff: string }

export function envoyAccess(sinceIso?: string): EnvoyAccess[] {
  return containerLog('envoy', sinceIso).split('\n').flatMap((l) => {
    if (!l.startsWith('{')) return [];
    try {
      const o = JSON.parse(l) as EnvoyAccess & { kind?: string };
      return o.kind === 'envoy-access' ? [o] : [];
    } catch {
      return [];
    }
  });
}

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── Keycloak admin API (direct, host port) ─────────────────────────────────────────────────────
const KC = `http://127.0.0.1:${STACK.ports.keycloak}`;

export async function kcAdmin<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
  });
  const { access_token } = (await tok.json()) as { access_token: string };
  const res = await fetch(`${KC}/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** The deployed distribution and WAF as floci holds them (written by floci/deploy-web.sh). */
export function deployed(): { distribution: { Id: string; DistributionConfig: { WebACLId?: string } }; waf: { WebACL?: { ARN: string; Rules: { Name: string }[] } } } {
  return {
    distribution: (JSON.parse(readFileSync(join(STATE, 'cloudfront/distribution.json'), 'utf8')) as { Distribution: never }).Distribution,
    waf: JSON.parse(readFileSync(join(STATE, 'cloudfront/waf.live.json'), 'utf8')) as never,
  };
}

export const traceIdOf = (traceparent: string | null | undefined): string | undefined => traceparent?.split('-')[1];
