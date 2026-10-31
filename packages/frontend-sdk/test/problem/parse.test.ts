import { describe, expect, it } from 'vitest';
import {
  GATEWAY_DENY_CODES,
  PlatformProblemTypes,
  ProblemError,
  gatewayDenyCode,
  parseProblemResponse,
  type ProblemDetails,
} from '../../src/problem/index.ts';
import { isProblemContentType } from '../../src/problem/parse.ts';
import { fixture } from '../core/helpers.ts';

interface Captured {
  name: string;
  source: 'go' | 'python';
  status: number;
  headers: Record<string, string>;
  body: string;
  expected: Omit<ProblemDetails, 'extensions'> & { extensions: Record<string, unknown> };
}

const MEMBERS = ['type', 'title', 'status', 'detail', 'instance', 'traceId', 'errorCode', 'tenantId', 'timestamp', 'validationErrors'] as const;

/** The members present on a parsed problem, in the shape go-probe writes `expected`. */
function asDecoded(p: ProblemError) {
  const out: Record<string, unknown> = {};
  for (const m of MEMBERS) if (p[m] !== undefined) out[m] = p[m];
  out.extensions = { ...p.extensions };
  return out;
}

const problemResponse = (body: unknown, status = 400, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

describe('problem_bodies.json: real gincommon and fastapicommon responses', () => {
  const { cases } = fixture<{ cases: Captured[] }>('problem_bodies.json');

  it('covers the same scenarios in both languages', () => {
    const names = (src: string) => cases.filter((c) => c.source === src).map((c) => c.name);
    expect(names('go').length).toBeGreaterThanOrEqual(8);
    expect(names('python')).toEqual(names('go'));
  });

  it.each(cases.map((c) => [`${c.source} ${c.name}`, c] as const))(
    "%s parses exactly as gincommon's decoder does",
    async (_, c) => {
      const p = await parseProblemResponse(new Response(c.body, { status: c.status, headers: c.headers }));
      expect(p.synthetic).toBe(false);
      expect(asDecoded(p)).toEqual(c.expected);
      expect(p.requestId).toBe(c.headers['x-request-id']);
      expect(p.message).toBe(c.expected.detail ?? c.expected.title);
    },
  );

  it('derives the same type id from Go and Python bodies', async () => {
    for (const name of new Set(cases.map((c) => c.name))) {
      const ids = await Promise.all(
        cases
          .filter((c) => c.name === name)
          .map(async (c) => (await parseProblemResponse(new Response(c.body, { status: c.status, headers: c.headers }))).typeId),
      );
      expect(new Set(ids).size, name).toBe(1);
    }
  });
});

describe('parseProblemResponse rules', () => {
  it('takes the response status when the body has none (or 0)', async () => {
    expect((await parseProblemResponse(problemResponse({ type: 'about:blank', title: 'x' }, 418))).status).toBe(418);
    expect((await parseProblemResponse(problemResponse({ title: 'x', status: 0 }, 409))).status).toBe(409);
  });

  it("keeps the body's status when it differs from the response's, as Go does", async () => {
    expect((await parseProblemResponse(problemResponse({ status: 404 }, 400))).status).toBe(404);
  });

  it('treats an absent type as about:blank (RFC 9457 §3.1.1)', async () => {
    const p = await parseProblemResponse(problemResponse({ title: 'Gone', status: 410 }, 410));
    expect(p.type).toBe('about:blank');
    expect(p.typeId).toBeUndefined();
  });

  it('matches standard members case-sensitively and drops case variants (no extension, no override)', async () => {
    const p = await parseProblemResponse(
      problemResponse({ type: 'https://errors.company.com/platform/conflict', title: 'Conflict', status: 409, Status: 200, TRACEID: 'x', tenantID: 't', record_version: 7 }, 409),
    );
    expect(p.status).toBe(409);
    expect(p.traceId).toBeUndefined();
    expect(p.tenantId).toBeUndefined();
    expect(p.extensions).toEqual({ record_version: 7 });
  });

  it('keeps every other top-level member as an extension, whatever its name or value', async () => {
    const p = await parseProblemResponse(problemResponse({ status: 409, 'bad-name': 1, nested: { a: [1, 2] }, nil: null }, 409));
    expect(p.extensions).toEqual({ 'bad-name': 1, nested: { a: [1, 2] }, nil: null });
    expect(Object.isFrozen(p.extensions)).toBe(true);
  });

  it('keeps a member named __proto__ as data, never as the prototype', async () => {
    const p = await parseProblemResponse(problemResponse('{"status":400,"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(p.extensions)).toBe(Object.prototype);
    expect(Object.keys(p.extensions)).toEqual(['__proto__']);
  });

  it('parses validationErrors: optional code, extra members kept, missing strings empty, null entries skipped', async () => {
    const p = await parseProblemResponse(
      problemResponse({
        type: 'https://errors.company.com/platform/validation-failed',
        title: 'Validation failed',
        status: 400,
        validationErrors: [
          { field: 'deadline', message: 'must be in the future', code: 'IN_PAST', min: '2026-01-01' },
          { field: 'items[0].sku' },
          null,
        ],
      }),
    );
    expect(p.validationErrors).toEqual([
      { field: 'deadline', message: 'must be in the future', code: 'IN_PAST', min: '2026-01-01' },
      { field: 'items[0].sku', message: '' },
    ]);
    expect(p.is(PlatformProblemTypes.ValidationFailed)).toBe(true);
  });

  it('treats null standard members as absent, as Go does', async () => {
    const p = await parseProblemResponse(problemResponse({ title: 'x', status: 404, detail: null, validationErrors: null }, 404));
    expect(p.detail).toBeUndefined();
    expect(p.validationErrors).toBeUndefined();
    expect(p.synthetic).toBe(false);
  });

  it.each([
    ['a string status', { status: '404' }],
    ['a fractional status', { status: 404.5 }],
    ['a numeric title', { title: 7 }],
    ['an object detail', { detail: { text: 'x' } }],
    ['validationErrors that is not an array', { validationErrors: { field: 'x' } }],
    ['a validationErrors entry that is not an object', { validationErrors: ['x'] }],
    ['a validationErrors field that is not a string', { validationErrors: [{ field: 1, message: 'm' }] }],
  ])('falls back to a synthetic problem for %s (Go cannot decode it)', async (_, body) => {
    const p = await parseProblemResponse(problemResponse(body, 404, { 'x-trace-id': '4bf92f3577b34da6a3ce929d0e0e4736' }));
    expect(p.synthetic).toBe(true);
    expect(p.status).toBe(404);
    expect(p.is(PlatformProblemTypes.NotFound)).toBe(true);
    expect(p.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it.each([
    ['invalid JSON', '{"status":'],
    ['an array', '[1,2]'],
    ['a JSON string', '"oops"'],
    ['an empty body', ''],
    ['trailing data', '{"status":500} garbage'],
  ])('falls back to a synthetic problem for %s', async (_, body) => {
    expect((await parseProblemResponse(problemResponse(body, 500))).synthetic).toBe(true);
  });

  it('falls back to a synthetic problem when the body is larger than the 1 MiB cap', async () => {
    const big = JSON.stringify({ status: 413, detail: 'x'.repeat(1024 * 1024) });
    const p = await parseProblemResponse(problemResponse(big, 413));
    expect(p.synthetic).toBe(true);
    expect(p.is(PlatformProblemTypes.PayloadTooLarge)).toBe(true);
  });
});

describe('synthetic problems (not application/problem+json)', () => {
  it('are built from the status, with trace and request ids from the headers, never the body', async () => {
    const res = new Response('<html>Bad gateway: secret upstream detail</html>', {
      status: 502,
      headers: { 'content-type': 'text/html', 'x-trace-id': '4BF92F3577B34DA6A3CE929D0E0E4736', 'x-request-id': 'r-1' },
    });
    const p = await parseProblemResponse(res);
    expect(p).toMatchObject({ synthetic: true, status: 502, type: 'about:blank', title: 'Bad Gateway', errorCode: 'BAD_GATEWAY' });
    expect(p.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(p.requestId).toBe('r-1');
    expect(p.detail).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('secret');
  });

  it('use the platform type when the status has one (400 is bad-request)', async () => {
    const p400 = await parseProblemResponse(new Response('nope', { status: 400 }));
    expect(p400.type).toBe('https://errors.company.com/platform/bad-request');
    expect(p400).toMatchObject({ title: 'Bad Request', errorCode: 'BAD_REQUEST' });
    const p503 = await parseProblemResponse(new Response(null, { status: 503 }));
    expect(p503.is(PlatformProblemTypes.ServiceUnavailable)).toBe(true);
  });

  it('ignore an invalid X-Trace-ID and fall back to the request id the call was sent with', async () => {
    const p = await parseProblemResponse(new Response('', { status: 500, headers: { 'x-trace-id': '0'.repeat(32) } }), {
      requestId: 'sent-1',
    });
    expect(p.traceId).toBeUndefined();
    expect(p.requestId).toBe('sent-1');
  });

  it("title a status net/http doesn't know 'Error'", async () => {
    const p = await parseProblemResponse(new Response('', { status: 599 }));
    expect(p).toMatchObject({ title: 'Error', errorCode: 'ERROR', type: 'about:blank' });
  });
});

describe('isProblemContentType', () => {
  it.each([
    ['application/problem+json', true],
    ['Application/Problem+JSON', true],
    ['application/problem+json; charset=utf-8', true],
    ['application/problem+json;charset="utf-8"', true],
    ['application/json', false],
    ['application/problem+json; charset', false],
    ['application/problem+jsonx', false],
    ['', false],
    [null, false],
  ])('%s → %s', (value, expected) => {
    expect(isProblemContentType(value)).toBe(expected);
  });
});

describe('gateway denials (iam-authz-enrichment deniedResponse, AE-42)', () => {
  // The shape AuthZ Enrichment #39 sends: platform type for the status, errorCode = deny reason.
  const denial = (code: string, status: number, typeName: string) =>
    problemResponse(
      {
        type: `https://errors.company.com/platform/${typeName}`,
        title: 'Forbidden',
        status,
        detail: 'This action needs a recent multi-factor sign-in.',
        instance: '/api/v1/approve',
        traceId: '32fccc00000000000000000000000001',
        errorCode: code,
        timestamp: '2026-10-29T22:14:41Z',
      },
      status,
    );

  it('lists the seven deny codes generated from decision.go', () => {
    expect(GATEWAY_DENY_CODES).toEqual([
      'DENY_UNRESOLVABLE_SUBJECT',
      'DENY_TENANT_READ_ONLY',
      'DENY_MFA_STALE',
      'DENY_TENDER_ACL_INSUFFICIENT',
      'DENY_ROLE_INSUFFICIENT',
      'DENY_SERVICE_UNAVAILABLE',
      'DENY_MALFORMED_IDENTITY',
    ]);
  });

  it('are ordinary problems whose errorCode is the deny reason', async () => {
    const p = await parseProblemResponse(denial('DENY_MFA_STALE', 403, 'forbidden'));
    expect(p.synthetic).toBe(false);
    expect(p.is(PlatformProblemTypes.Forbidden)).toBe(true);
    expect(gatewayDenyCode(p)).toBe('DENY_MFA_STALE');
    expect(p.tenantId).toBeUndefined();
  });

  it('match on the type path, not the base', async () => {
    const res = problemResponse({ type: 'https://errors.other-org.example/platform/unauthorized', title: 'Unauthorized', status: 401, errorCode: 'DENY_MALFORMED_IDENTITY' }, 401);
    const p = await parseProblemResponse(res);
    expect(p.is(PlatformProblemTypes.Unauthorized)).toBe(true);
    expect(gatewayDenyCode(p)).toBe('DENY_MALFORMED_IDENTITY');
  });

  it('give undefined for any other errorCode', async () => {
    expect(gatewayDenyCode(await parseProblemResponse(problemResponse({ status: 403, errorCode: 'FORBIDDEN' }, 403)))).toBeUndefined();
    expect(gatewayDenyCode(await parseProblemResponse(problemResponse({ status: 403 }, 403)))).toBeUndefined();
  });
});

describe('parseProblemResponse: unreadable bodies', () => {
  const stream = (source: UnderlyingDefaultSource<Uint8Array>) =>
    new Response(new ReadableStream<Uint8Array>(source), { status: 502, headers: { 'content-type': 'application/problem+json', 'x-request-id': 'rid' } });

  it('treats a problem response with no body as unparsable: synthetic, with the request id', async () => {
    const p = await parseProblemResponse(new Response(null, { status: 404, headers: { 'content-type': 'application/problem+json' } }), { requestId: 'sent' });
    expect(p.synthetic).toBe(true);
    expect(p.status).toBe(404);
    expect(p.is(PlatformProblemTypes.NotFound)).toBe(true);
    expect(p.requestId).toBe('sent');
  });

  it('falls back to a synthetic problem when reading the body fails mid-stream', async () => {
    const enc = new TextEncoder();
    let sent = false;
    const res = stream({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('{"status":502,"detail":"secret'));
        } else c.error(new TypeError('connection reset'));
      },
    });
    const p = await parseProblemResponse(res);
    expect(p.synthetic).toBe(true);
    expect(p.status).toBe(502);
    expect(p.detail).toBeUndefined(); // the partial body is never surfaced
    expect(p.requestId).toBe('rid');
  });

  it('still returns a synthetic problem when cancelling an oversized body fails', async () => {
    const chunk = new Uint8Array(1024 * 1024 + 1).fill(0x20);
    const res = stream({
      start(c) {
        c.enqueue(chunk);
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });
    const p = await parseProblemResponse(res);
    expect(p.synthetic).toBe(true);
    expect(p.status).toBe(502);
  });

  it('still returns a synthetic problem when discarding a non-problem body fails', async () => {
    const res = new Response('<html>', { status: 503, headers: { 'content-type': 'text/html' } });
    res.body!.getReader(); // locked: cancel() rejects
    const p = await parseProblemResponse(res);
    expect(p.synthetic).toBe(true);
    expect(p.is(PlatformProblemTypes.ServiceUnavailable)).toBe(true);
  });
});
