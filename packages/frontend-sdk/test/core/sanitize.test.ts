import { describe, expect, it } from 'vitest';
import { isSensitiveKey, sanitizeFields, sanitizeString } from '../../src/core/index.ts';
import { REDACTION } from '../../src/internal/generated/redaction.ts';
import { fixture } from './helpers.ts';

interface RedactionCases {
  keys: { key: string; sensitive: boolean }[];
  fields: { name: string; input: Record<string, unknown>; expected: Record<string, unknown> }[];
  strings: { name: string; input: string; expected: string; expectedSdk?: string }[];
}

const cases = fixture<RedactionCases>('redaction_cases.json');

describe('redaction_cases.json (shared with gincommon and fastapicommon)', () => {
  it.each(cases.keys.map((c) => [JSON.stringify(c.key), c] as const))('key %s', (_, c) => {
    expect(isSensitiveKey(c.key)).toBe(c.sensitive);
  });

  it.each(cases.fields.map((c) => [c.name, c] as const))('fields: %s', (_, c) => {
    expect(sanitizeFields(c.input)).toEqual(c.expected);
  });

  it.each(cases.strings.map((c) => [c.name, c] as const))('string: %s', (_, c) => {
    expect(sanitizeString(c.input)).toBe(c.expectedSdk ?? c.expected);
  });

  it('marks exactly the U+2028/U+2029 cases as SDK-specific', () => {
    const sdkOnly = cases.strings.filter((c) => c.expectedSdk !== undefined);
    expect(sdkOnly.length).toBeGreaterThan(0);
    for (const c of sdkOnly) expect(c.input).toMatch(/[\u2028\u2029]/);
  });
});

describe('isSensitiveKey', () => {
  it('uses the exact keys and substrings generated from log_sanitizer.go', () => {
    for (const k of REDACTION.exactKeys) expect(isSensitiveKey(k)).toBe(true);
    for (const s of REDACTION.substrings) expect(isSensitiveKey(`x_${s}_y`)).toBe(true);
  });

  it("trims like Go's strings.TrimSpace, not String.prototype.trim", () => {
    expect(isSensitiveKey('\u0085password\u0085')).toBe(true); // NEL is Go whitespace
    expect(isSensitiveKey('\u00a0token\u2028')).toBe(true);
    expect(isSensitiveKey('\ufeffcookie')).toBe(false); // BOM is not Go whitespace: no exact match
  });

  it('is false for non-strings from untyped callers', () => {
    expect(isSensitiveKey(undefined as unknown as string)).toBe(false);
  });
});

describe('sanitizeString', () => {
  it('strips control characters before measuring, then never splits a character', () => {
    expect(sanitizeString('\u0000'.repeat(300) + 'ok')).toBe('ok');
    expect(new TextEncoder().encode(sanitizeString('ü'.repeat(200))).length).toBe(256);
  });

  it('counts a lone surrogate as the 3-byte replacement character it encodes to', () => {
    const s = 'a'.repeat(253) + '\ud800';
    expect(sanitizeString(s)).toBe(s);
    expect(sanitizeString('a'.repeat(254) + '\ud800')).toBe('a'.repeat(254));
  });

  it('stringifies non-strings from untyped callers', () => {
    expect(sanitizeString(42 as unknown as string)).toBe('42');
  });
});

describe('sanitizeFields (deep, TypeScript only)', () => {
  it('redacts sensitive keys at any depth, in objects and arrays', () => {
    const input = {
      user: { name: 'a', password: 'p', profile: { api_key: 'k', city: 'Dubai' } },
      items: [{ token: 't', id: 1 }, 'plain', [{ secret: 's' }]],
    };
    expect(sanitizeFields(input)).toEqual({
      user: { name: 'a', password: '[REDACTED]', profile: { api_key: '[REDACTED]', city: 'Dubai' } },
      items: [{ token: '[REDACTED]', id: 1 }, 'plain', [{ secret: '[REDACTED]' }]],
    });
  });

  it('never mutates its input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    const copy = structuredClone(input);
    sanitizeFields(input);
    expect(input).toEqual(copy);
  });

  it('replaces reference cycles but keeps repeated, non-cyclic references', () => {
    const shared = { ok: 1 };
    const input: Record<string, unknown> = { a: shared, b: shared };
    input.self = input;
    const list: unknown[] = [];
    list.push(list);
    input.list = list;
    expect(sanitizeFields(input)).toEqual({ a: { ok: 1 }, b: { ok: 1 }, self: '[Circular]', list: ['[Circular]'] });
  });

  it('passes class instances through and redacts them under a sensitive key', () => {
    const when = new Date(0);
    const err = new Error('boom');
    const out = sanitizeFields({ when, err, session: new Date(1) });
    expect(out.when).toBe(when);
    expect(out.err).toBe(err);
    expect(out.session).toBe('[REDACTED]');
  });

  it('accepts null-prototype objects and returns {} for non-objects', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { token: 'x', a: 1 });
    expect(sanitizeFields(bare)).toEqual({ token: '[REDACTED]', a: 1 });
    expect(sanitizeFields(null as unknown as Record<string, unknown>)).toEqual({});
    expect(sanitizeFields([] as unknown as Record<string, unknown>)).toEqual({});
  });
});
