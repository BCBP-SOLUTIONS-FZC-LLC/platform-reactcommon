// mockApi and mockProblem (design doc §C1 /testing): answer the SDK's real ApiClient from a route table,
// with RFC 9457 bodies shaped like platform-gincommon's.
import { tryGetConfig } from '../config/index.ts';
import { DEFAULT_TYPE_BASE, PROBLEM_CONTENT_TYPE, PlatformProblemTypes, type ProblemDetails, type ProblemType } from '../problem/index.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Handler = Response | ((req: Request) => Response);

let original: typeof fetch | undefined;

/** Puts back the fetch mockApi replaced (createTestPlatform and its reset() call it). */
export function restoreFetch(): void {
  if (original) globalThis.fetch = original;
  original = undefined;
}

/**
 * A problem response for `t`, as platform-gincommon writes it: type under the default base, title,
 * status, errorCode, timestamp, then `extra` (extensions become top-level members).
 */
export function mockProblem(t: ProblemType, extra?: Partial<ProblemDetails>): Response {
  const { extensions, ...rest } = extra ?? {};
  const body = {
    type: `${DEFAULT_TYPE_BASE}/${t.id}`,
    title: t.title,
    status: t.status,
    errorCode: t.code,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extensions,
    ...rest,
  };
  const headers: Record<string, string> = { 'content-type': PROBLEM_CONTENT_TYPE };
  if (body.traceId) headers['x-trace-id'] = body.traceId;
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

function compile(route: string): { method: Method; match: (path: string) => boolean } {
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(route);
  if (!m) throw new TypeError(`mockApi route must look like 'GET /tenders/:id', got ${JSON.stringify(route)}`);
  const segments = m[2]!.split('/');
  return {
    method: m[1] as Method,
    match: (path) => {
      const parts = path.split('/');
      return parts.length === segments.length && segments.every((s, i) => s.startsWith(':') ? parts[i] !== '' : s === parts[i]);
    },
  };
}

/**
 * Replaces fetch with `routes`: 'METHOD /path' keys relative to the runtime config's api.baseUrl
 * (':name' matches one segment), each a Response (cloned per call) or a function of the Request.
 * Anything else answers 404 (errorCode ROUTE_NOT_FOUND, as gincommon's NoRoute). Undone by reset() or the next createTestPlatform.
 */
export function mockApi(routes: Record<`${Method} /${string}`, Handler>): void {
  const table = Object.entries(routes).map(([route, handler]) => ({ ...compile(route), handler: handler as Handler }));
  original ??= globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input instanceof Request ? input : new URL(String(input), globalThis.location?.href ?? 'http://localhost/'), init);
    const base = (tryGetConfig()?.api.baseUrl ?? '').replace(/\/$/, '');
    let path = new URL(req.url).pathname;
    if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || '/';
    const hit = table.find((r) => r.method === req.method && r.match(path));
    if (!hit) return mockProblem(PlatformProblemTypes.NotFound, { errorCode: 'ROUTE_NOT_FOUND', detail: `no mock for ${req.method} ${path}` });
    return typeof hit.handler === 'function' ? hit.handler(req) : hit.handler.clone();
  };
}
