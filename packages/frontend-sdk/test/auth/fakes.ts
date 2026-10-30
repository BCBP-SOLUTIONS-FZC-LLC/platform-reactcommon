// Test doubles for /auth: a browser page (location, history, storages, events, BroadcastChannel) and
// a Keycloak that behaves like RP #41's tender-web at the HTTP level (PKCE, rotation with max reuse 0
// per lineage: sending a replaced refresh token revokes the whole SSO session).
import { createHash, randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { FakeStorage } from '../core/helpers.ts';

export const ORIGIN = 'https://app.example.com';
export const IDP = 'https://auth.example.com';
export const CLIENT = 'tender-web';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function jwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('sig')}`;
}

/** A page: location + history over one URL, its own sessionStorage, a shared or own localStorage. */
export class FakePage {
  url: URL;
  readonly session = new FakeStorage();
  readonly events = new EventTarget();
  readonly assigned: string[] = [];
  online = true;

  constructor(
    path: string,
    readonly local: FakeStorage = new FakeStorage(),
  ) {
    this.url = new URL(path, ORIGIN);
  }

  /** Makes this page the global one (each test "tab" is installed before it acts). */
  install(): void {
    const url = () => this.url;
    const online = () => this.online;
    const location = {
      get href() {
        return url().href;
      },
      get origin() {
        return url().origin;
      },
      get pathname() {
        return url().pathname;
      },
      get search() {
        return url().search;
      },
      get hash() {
        return url().hash;
      },
      assign: (u: string) => this.assigned.push(u),
      replace: (u: string) => this.assigned.push(u),
      reload: () => {},
    };
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', {
      state: null,
      replaceState: (_s: unknown, _t: string, u: string) => {
        const next = new URL(u, this.url);
        if (next.origin !== this.url.origin) throw new DOMException('cross-origin', 'SecurityError');
        this.url = next;
      },
    });
    vi.stubGlobal('localStorage', this.local);
    vi.stubGlobal('sessionStorage', this.session);
    vi.stubGlobal('navigator', {
      get onLine() {
        return online();
      },
    });
    vi.stubGlobal('addEventListener', this.events.addEventListener.bind(this.events));
    vi.stubGlobal('removeEventListener', this.events.removeEventListener.bind(this.events));
  }

  goOnline(): void {
    this.online = true;
    this.events.dispatchEvent(new Event('online'));
  }

  /** Every value in both storages, to check that no token was ever written. */
  storedValues(): string {
    const all: string[] = [];
    for (const s of [this.local, this.session]) for (let i = 0; i < s.length; i++) all.push(`${s.key(i)}=${s.getItem(s.key(i)!)}`);
    return all.join('\n');
  }
}

/** BroadcastChannel across the "tabs" of one test; messages are delivered asynchronously, never to the sender. */
export class FakeBroadcastChannel extends EventTarget {
  static open = new Set<FakeBroadcastChannel>();
  static sent: unknown[] = [];
  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown): void {
    FakeBroadcastChannel.sent.push(data);
    for (const c of FakeBroadcastChannel.open) {
      if (c !== this && c.name === this.name) queueMicrotask(() => c.dispatchEvent(new MessageEvent('message', { data })));
    }
  }
  close(): void {
    FakeBroadcastChannel.open.delete(this);
  }
  static reset(): void {
    FakeBroadcastChannel.open.clear();
    FakeBroadcastChannel.sent = [];
  }
}

interface Grant {
  realm: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}
interface Lineage {
  current: string;
  realm: string;
  nonce: string;
  claims: Record<string, unknown>;
}

type Failure = 'network-after-send' | 'network-before-send' | 'server-error' | 'invalid_grant' | 'bad-id-token';

/** Keycloak at the HTTP level: /auth (via approve()), /token (fetch). */
export class FakeKeycloak {
  readonly requests: { grant: string; refreshToken?: string; body: URLSearchParams }[] = [];
  private codes = new Map<string, Grant>();
  private lineages = new Map<string, Lineage>();
  sessionRevoked = false;
  /** The next token responses fail like this, in order. */
  failures: Failure[] = [];
  accessTtl = 300;
  refreshTtl = 28_800;
  /** Claims added to the next ID tokens (e.g. tenant_id, auth_time) or overrides. */
  extraClaims: Record<string, unknown> = {};
  reuseDetected = 0;

  constructor(readonly now: () => number = () => Date.now()) {}

  issuer(realm: string): string {
    return `${IDP}/realms/${realm}`;
  }

  /** The user signs in at the authorize URL; returns the callback URL Keycloak redirects to. */
  approve(authorizeUrl: string, o?: { claims?: Record<string, unknown>; iss?: string | null }): string {
    const u = new URL(authorizeUrl);
    const realm = /^\/realms\/([^/]+)\/protocol\/openid-connect\/auth$/.exec(u.pathname)?.[1];
    if (!realm) throw new Error(`not an authorize URL: ${authorizeUrl}`);
    const p = u.searchParams;
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, {
      realm,
      clientId: p.get('client_id')!,
      redirectUri: p.get('redirect_uri')!,
      challenge: p.get('code_challenge')!,
      nonce: p.get('nonce')!,
      claims: { ...this.extraClaims, ...o?.claims },
    });
    const cb = new URL(p.get('redirect_uri')!);
    cb.searchParams.set('code', code);
    cb.searchParams.set('state', p.get('state')!);
    if (o?.iss !== null) cb.searchParams.set('iss', o?.iss ?? this.issuer(realm));
    return cb.href;
  }

  /** Keycloak answers a prompt=none (or any) attempt with an error. */
  deny(authorizeUrl: string, error: string): string {
    const u = new URL(authorizeUrl);
    const realm = /^\/realms\/([^/]+)\//.exec(u.pathname)![1]!;
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    cb.searchParams.set('error', error);
    cb.searchParams.set('state', u.searchParams.get('state')!);
    cb.searchParams.set('iss', this.issuer(realm));
    return cb.href;
  }

  private tokens(realm: string, nonce: string, claims: Record<string, unknown>, lineageId?: string) {
    const now = Math.floor(this.now() / 1000);
    const refresh = randomBytes(16).toString('hex');
    const id = lineageId ?? randomBytes(8).toString('hex');
    this.lineages.set(id, { current: refresh, realm, nonce, claims });
    const idClaims = { iss: this.issuer(realm), aud: CLIENT, azp: CLIENT, sub: 'user-1', nonce, iat: now, exp: now + this.accessTtl, name: 'Ada', email: 'ada@example.com', ...claims };
    return {
      access_token: `at-${randomBytes(8).toString('hex')}`,
      id_token: jwt(idClaims),
      refresh_token: refresh,
      expires_in: this.accessTtl,
      refresh_expires_in: this.refreshTtl,
      token_type: 'Bearer',
    };
  }

  fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ''));
    const grant = body.get('grant_type') ?? '';
    const failure = this.failures.shift();
    if (failure === 'network-before-send') throw new TypeError('Failed to fetch');
    this.requests.push({ grant, body, ...(body.get('refresh_token') ? { refreshToken: body.get('refresh_token')! } : {}) });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const realm = /^\/realms\/([^/]+)\/protocol\/openid-connect\/token$/.exec(url.pathname)?.[1];
    if (!realm) return json(404, { error: 'not_found' });
    if (body.get('client_id') !== CLIENT) return json(401, { error: 'invalid_client' });

    let answer: Response;
    if (grant === 'authorization_code') {
      const g = this.codes.get(body.get('code') ?? '');
      this.codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (!g || g.realm !== realm || g.redirectUri !== body.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== g.challenge) {
        return json(400, { error: 'invalid_grant' });
      }
      answer = json(200, this.tokens(realm, g.nonce, g.claims));
    } else if (grant === 'refresh_token') {
      const sent = body.get('refresh_token') ?? '';
      const entry = [...this.lineages.entries()].find(([, l]) => l.current === sent);
      const replaced = !entry && sent !== '';
      if (replaced) {
        // max reuse 0: a replaced token is reuse, and Keycloak ends the SSO session.
        this.reuseDetected++;
        this.sessionRevoked = true;
      }
      if (this.sessionRevoked || !entry || failure === 'invalid_grant') answer = json(400, { error: 'invalid_grant', error_description: 'Session not active' });
      else answer = json(200, this.tokens(entry[1].realm, entry[1].nonce, entry[1].claims, entry[0])); // rotates
    } else {
      answer = json(400, { error: 'unsupported_grant_type' });
    }
    if (failure === 'network-after-send') throw new TypeError('Failed to fetch'); // the server already rotated
    if (failure === 'server-error') return json(502, { error: 'bad_gateway' });
    if (failure === 'bad-id-token' && answer.ok) {
      const b = (await answer.json()) as Record<string, unknown>;
      return json(200, { ...b, id_token: jwt({ iss: 'https://evil.example', aud: CLIENT, sub: 'user-1', iat: 0, exp: 0 }) });
    }
    return answer;
  });
}
