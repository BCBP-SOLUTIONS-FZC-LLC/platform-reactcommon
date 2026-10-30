import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  DEFAULT_TYPE_BASE,
  NetworkError,
  PROBLEM_CONTENT_TYPE,
  PlatformProblemTypes,
  ProblemError,
  TimeoutError,
  defineProblemType,
  isProblemError,
  toFieldErrorMap,
  typeForStatus,
} from '../../src/problem/index.ts';
import { typeIdOf } from '../../src/problem/errors.ts';
import { PROBLEM } from '../../src/internal/generated/contracts.ts';

describe('platform type registry', () => {
  it('has the 15 types of gincommon PlatformTypes(), in registry order', () => {
    expect(Object.keys(PlatformProblemTypes)).toEqual([
      'BadRequest', 'ValidationFailed', 'Unauthorized', 'Forbidden', 'NotFound', 'MethodNotAllowed', 'Conflict',
      'PayloadTooLarge', 'UnsupportedMediaType', 'BusinessRuleViolation', 'RateLimitExceeded', 'InternalError',
      'NotImplemented', 'ServiceUnavailable', 'GatewayTimeout',
    ]);
    expect(Object.values(PlatformProblemTypes)).toEqual(PROBLEM.types);
    expect(PlatformProblemTypes.NotFound).toEqual({
      domain: 'platform', name: 'not-found', id: 'platform/not-found', title: 'Not Found', status: 404, code: 'NOT_FOUND',
    });
    expect(Object.isFrozen(PlatformProblemTypes)).toBe(true);
  });

  it('exports the generated constants', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
    expect(DEFAULT_TYPE_BASE).toBe('https://errors.company.com');
  });
});

describe('typeForStatus (gincommon TypeForStatus)', () => {
  it('maps 400 to bad-request, not validation-failed', () => {
    expect(typeForStatus(400)).toBe(PlatformProblemTypes.BadRequest);
  });

  it('agrees with the generated Go table for every status Go knows', () => {
    for (const row of PROBLEM.typeForStatus) expect(typeForStatus(row.status)?.id ?? null).toBe(row.id);
  });

  it('is undefined for about:blank statuses', () => {
    expect(typeForStatus(410)).toBeUndefined();
    expect(typeForStatus(599)).toBeUndefined();
  });
});

describe('defineProblemType (gincommon NewType rules)', () => {
  it('builds a frozen type with its id', () => {
    const t = defineProblemType('tender', 'invalid-stage', 'Invalid stage', 422, 'TENDER_INVALID_STAGE');
    expect(t).toEqual({ domain: 'tender', name: 'invalid-stage', id: 'tender/invalid-stage', title: 'Invalid stage', status: 422, code: 'TENDER_INVALID_STAGE' });
    expect(Object.isFrozen(t)).toBe(true);
  });

  it.each([
    ['a non-slug domain', ['Tender', 'x', 'T', 404, 'X'], 'domain'],
    ['a versioned domain', ['tender_v2', 'x', 'T', 404, 'X'], 'domain'],
    ['the reserved platform domain', ['platform', 'x', 'T', 404, 'X'], 'reserved'],
    ['a non-slug name', ['tender', 'not_found', 'T', 404, 'X'], 'name'],
    ['a trailing hyphen', ['tender', 'x-', 'T', 404, 'X'], 'name'],
    ['a blank title', ['tender', 'x', '  ', 404, 'X'], 'title'],
    ['a 3xx status', ['tender', 'x', 'T', 302, 'X'], 'status'],
    ['a 600 status', ['tender', 'x', 'T', 600, 'X'], 'status'],
    ['a fractional status', ['tender', 'x', 'T', 404.5, 'X'], 'status'],
    ['a lower-case code', ['tender', 'x', 'T', 404, 'not_found'], 'code'],
    ['a code with a trailing underscore', ['tender', 'x', 'T', 404, 'NOT_'], 'code'],
  ] as const)('rejects %s', (_, args, what) => {
    expect(() => defineProblemType(...(args as unknown as Parameters<typeof defineProblemType>))).toThrow(TypeError);
    expect(() => defineProblemType(...(args as unknown as Parameters<typeof defineProblemType>))).toThrow(what);
  });
});

describe('type ids', () => {
  it.each([
    ['https://errors.company.com/platform/not-found', 'platform/not-found'],
    ['https://errors.other.example/v1/errors/tender/invalid-stage', 'tender/invalid-stage'],
    ['https://errors.company.com/platform/not-found/', 'platform/not-found'],
    ['about:blank', undefined],
    ['https://errors.company.com/only-one', undefined],
    ['/platform/not-found', undefined],
    ['', undefined],
  ])('%s → %s', (type, id) => {
    expect(typeIdOf(type)).toBe(id);
  });
});

describe('ProblemError', () => {
  const details = {
    type: 'https://errors.company.com/platform/validation-failed',
    title: 'Validation failed',
    status: 400,
    validationErrors: [
      { field: 'items[0].sku', message: 'is required' },
      { field: 'items[0].sku', message: 'must be 8 characters' },
      { field: '__proto__', message: 'is not allowed' },
    ],
    extensions: {},
  };

  it('compares by type id only', () => {
    const p = new ProblemError({ ...details, title: 'Something else' });
    expect(p.is(PlatformProblemTypes.ValidationFailed)).toBe(true);
    expect(p.is(PlatformProblemTypes.BadRequest)).toBe(false);
    expect(new ProblemError({ ...details, type: 'about:blank' }).is(PlatformProblemTypes.BadRequest)).toBe(false);
  });

  it('is an Error whose message is the detail, else the title', () => {
    const p = new ProblemError({ ...details, detail: 'Fix the items.' });
    expect(p).toBeInstanceOf(Error);
    expect(p.name).toBe('ProblemError');
    expect(p.message).toBe('Fix the items.');
    expect(new ProblemError(details).message).toBe('Validation failed');
  });

  it('groups validation errors by field path, safely', () => {
    const map = toFieldErrorMap(new ProblemError(details));
    expect(map['items[0].sku']).toEqual(['is required', 'must be 8 characters']);
    expect(map['__proto__']).toEqual(['is not allowed']);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(toFieldErrorMap(new ProblemError({ ...details, validationErrors: undefined } as never))).toEqual({});
  });

  it('is recognised across SDK copies by its brand, not by instanceof', () => {
    expect(isProblemError(new ProblemError(details))).toBe(true);
    const foreign = Object.create(null) as Record<symbol, unknown>;
    foreign[Symbol.for('@platform/frontend-sdk/ProblemError')] = true;
    expect(isProblemError(foreign)).toBe(true);
    expect(isProblemError(new Error('x'))).toBe(false);
    expect(isProblemError({ type: 'x', status: 400 })).toBe(false);
    expect(isProblemError(null)).toBe(false);
  });
});

describe('transport errors', () => {
  it('carry what the caller needs to report them', () => {
    const t = new TimeoutError(35000, 'r-1');
    expect(t).toMatchObject({ name: 'TimeoutError', timeoutMs: 35000, requestId: 'r-1' });
    expect(t.message).toContain('35000');
    const offline = new NetworkError(true, 'r-2');
    expect(offline).toMatchObject({ name: 'NetworkError', offline: true, requestId: 'r-2' });
    expect(offline.message).toContain('offline');
    const cause = new TypeError('Failed to fetch');
    expect(new NetworkError(false, 'r-3', { cause }).cause).toBe(cause);
    expect(new AbortedError()).toMatchObject({ name: 'AbortedError', message: 'the request was aborted' });
  });
});
