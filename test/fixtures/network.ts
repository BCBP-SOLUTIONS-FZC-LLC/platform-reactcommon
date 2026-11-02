// The network behind a FakePage for the integration and e2e suites: Keycloak (FakeKeycloak) on its
// own origin, and the shell's origin answering from a route table (runtime config, manifest, API).
// Every request is kept as a Request, headers included, so a suite asserts what was actually sent.
import { vi } from 'vitest';
import { PlatformProblemTypes } from '../../packages/frontend-sdk/src/problem/index.ts';
import { mockProblem } from '../../packages/frontend-sdk/src/testing/index.ts';
import { IDP, ORIGIN, type FakeKeycloak } from './keycloak.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Handler = (req: Request) => Response | Promise<Response>;

export class FakeNetwork {
  /** Every request to the shell's origin (Keycloak's are in FakeKeycloak.requests). */
  readonly requests: Request[] = [];
  private readonly routes: { method: Method; segments: string[]; handler: Handler }[] = [];

  constructor(readonly kc: FakeKeycloak) {}

  /**
   * Answers 'METHOD /path' (':name' matches one segment) on the page origin with a handler, a
   * Response (cloned per request) or a JSON body; a later route for the same path wins.
   */
  on(route: `${Method} /${string}`, handler: Handler): this;
  on(route: `${Method} /${string}`, answer: Response | object): this;
  on(route: `${Method} /${string}`, handler: Handler | Response | object): this {
    const [method, path] = route.split(' ') as [Method, string];
    const h: Handler =
      typeof handler === 'function' ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => Response.json(handler);
    this.routes.unshift({ method, segments: path.split('/'), handler: h });
    return this;
  }

  /** Requests whose path is `path` (no query). */
  sent(path: string): Request[] {
    return this.requests.filter((r) => new URL(r.url).pathname === path);
  }

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href, ORIGIN);
    if (url.origin === IDP) return this.kc.fetch(url.href, init);
    const req = new Request(url, input instanceof Request ? input : init);
    this.requests.push(req.clone());
    if (url.origin !== ORIGIN) throw new TypeError(`Failed to fetch: no network to ${url.origin}`);
    const parts = url.pathname.split('/');
    const hit = this.routes.find(
      (r) => r.method === req.method && r.segments.length === parts.length && r.segments.every((s, i) => (s.startsWith(':') ? parts[i] !== '' : s === parts[i])),
    );
    if (!hit) return mockProblem(PlatformProblemTypes.NotFound, { errorCode: 'ROUTE_NOT_FOUND' });
    return hit.handler(req);
  });
}
