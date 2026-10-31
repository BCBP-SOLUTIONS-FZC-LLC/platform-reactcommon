import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorUrl, isExactOrigin, isSameOriginPath } from '../../src/internal/urls.ts';

afterEach(() => vi.unstubAllGlobals());

describe('isExactOrigin', () => {
  it.each([
    ['https://cdn.bcbpsolutions.com', true],
    ['http://localhost:8080', true],
    ['https://cdn.bcbpsolutions.com/', false],
    ['https://cdn.bcbpsolutions.com/path', false],
    ['https://user@cdn.bcbpsolutions.com', false],
    ['HTTPS://CDN.bcbpsolutions.com', false],
    ['cdn.bcbpsolutions.com', false],
    ['', false],
    ['https://[bad', false],
  ])('%j → %s', (value, expected) => {
    expect(isExactOrigin(value)).toBe(expected);
  });
});

describe('collectorUrl', () => {
  it('builds the OTLP URL under a same-origin base path on the page origin', () => {
    vi.stubGlobal('location', new URL('https://app.bcbpsolutions.com/t/acme/'));
    expect(collectorUrl('/otel/', 'traces')).toBe('https://app.bcbpsolutions.com/otel/v1/traces');
    vi.stubGlobal('location', undefined);
    expect(collectorUrl('/otel', 'logs')).toBe('http://localhost/otel/v1/logs');
  });

  it.each(['https://evil.example/otel', '//evil.example/otel', 'otel', '/otel?x=1', '/a\\b', 42 as never])('refuses %j as a base', (base) => {
    expect(isSameOriginPath(base)).toBe(false);
    expect(() => collectorUrl(base, 'metrics')).toThrow(TypeError);
  });
});
