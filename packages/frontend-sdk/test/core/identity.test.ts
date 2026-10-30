import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOMAINS,
  ENVIRONMENTS,
  IdentityMismatchError,
  InvalidIdentityError,
  NotInitializedError,
  getIdentity,
  initializeCore,
  isInitialized,
  type CoreIdentityInput,
} from '../../src/core/index.ts';
import { REGISTRY_VOCAB } from '../../src/internal/generated/registry-vocab.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { fixture } from './helpers.ts';

interface IdentityCase {
  name: string;
  input: { service: string; domain: string; environment: string; version?: string };
  identity?: { service: string; domain: string; environment: string; version: string };
  error?: 'service' | 'domain' | 'environment' | 'version';
}

const FIELD = { service: 'serviceName', domain: 'domain', environment: 'environment', version: 'buildVersion' } as const;
const toInput = (i: IdentityCase['input']): CoreIdentityInput => ({
  serviceName: i.service,
  domain: i.domain,
  environment: i.environment,
  ...(i.version === undefined ? {} : { buildVersion: i.version }),
});

beforeEach(() => resetRuntimeForTests());

describe('identity_cases.json (shared with go-probe identity-check)', () => {
  const { cases } = fixture<{ cases: IdentityCase[] }>('identity_cases.json');

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    if (c.error) {
      const err = (() => {
        try {
          initializeCore(toInput(c.input));
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(InvalidIdentityError);
      expect((err as InvalidIdentityError).field).toBe(FIELD[c.error]);
      expect(isInitialized()).toBe(false);
    } else {
      expect(initializeCore(toInput(c.input))).toEqual({
        serviceName: c.identity!.service,
        domain: c.identity!.domain,
        environment: c.identity!.environment,
        buildVersion: c.identity!.version,
      });
    }
  });
});

describe('initializeCore', () => {
  const input = { serviceName: 'web-app', domain: 'tender_management', environment: 'dev', buildVersion: '1.0.0' };

  it('stores a frozen identity readable through getIdentity', () => {
    expect(isInitialized()).toBe(false);
    expect(getIdentity()).toBeUndefined();
    const id = initializeCore(input);
    expect(isInitialized()).toBe(true);
    expect(getIdentity()).toBe(id);
    expect(Object.isFrozen(id)).toBe(true);
  });

  it("accepts the multi-domain shell's identity (domain 'portal', design doc §D1)", () => {
    expect(initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'prod', buildVersion: '1.0.0' }).domain).toBe('portal');
  });

  it('is idempotent for an identity that normalises to the same values', () => {
    const first = initializeCore(input);
    expect(initializeCore({ ...input, environment: ' DEV ', buildVersion: ' 1.0.0 ' })).toBe(first);
  });

  it('rejects a second, different identity and names the differing field', () => {
    initializeCore(input);
    expect(() => initializeCore({ ...input, buildVersion: '2.0.0' })).toThrow(IdentityMismatchError);
    try {
      initializeCore({ ...input, environment: 'prod' });
    } catch (e) {
      const err = e as IdentityMismatchError;
      expect(err.existing.environment).toBe('dev');
      expect(err.attempted.environment).toBe('prod');
      expect(err.message).toContain('environment');
    }
    expect(getIdentity()?.buildVersion).toBe('1.0.0');
  });

  it('rejects non-string values from untyped callers instead of coercing them', () => {
    const bad = (patch: Record<string, unknown>) => () => initializeCore({ ...input, ...patch } as CoreIdentityInput);
    expect(bad({ domain: undefined })).toThrow(expect.objectContaining({ field: 'domain' }));
    expect(bad({ serviceName: 42 })).toThrow(expect.objectContaining({ field: 'serviceName' }));
    expect(bad({ environment: null })).toThrow(expect.objectContaining({ field: 'environment' }));
    expect(bad({ buildVersion: 1 })).toThrow(expect.objectContaining({ field: 'buildVersion' }));
  });

  it('validates domain first, as the backend does', () => {
    expect(() => initializeCore({ serviceName: 'BAD', domain: 'nope', environment: 'nope' })).toThrow(
      expect.objectContaining({ field: 'domain' }),
    );
  });

});

describe('vocabularies', () => {
  it('come from the generated registry contract', () => {
    expect(DOMAINS).toEqual(REGISTRY_VOCAB.domains);
    expect(ENVIRONMENTS).toEqual(['local', 'dev', 'test', 'staging', 'prod']);
    expect(ENVIRONMENTS).not.toContain('production');
  });
});

describe('error classes', () => {
  it('carry their names', () => {
    expect(new NotInitializedError('x').name).toBe('NotInitializedError');
    expect(new InvalidIdentityError('domain', 'x').name).toBe('InvalidIdentityError');
  });
});
