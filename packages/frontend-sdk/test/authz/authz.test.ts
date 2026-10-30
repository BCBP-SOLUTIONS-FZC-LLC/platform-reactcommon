import { beforeEach, describe, expect, it } from 'vitest';
import { denyAll, hasPermission, roleMapAuthorizer, setAuthorizer, setAuthzSubject, type Authorizer } from '../../src/authz/index.ts';
import { parseRoles } from '../../src/authz/roles.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { fixture } from '../core/helpers.ts';

interface HeaderCases {
  roles_cases: { name: string; raw: string; expected: string[] | null }[];
  roles_length_cases: { name: string; length: number; valid: boolean }[];
}
const cases = fixture<HeaderCases>('header_cases.json');

beforeEach(() => resetRuntimeForTests());

describe('parseRoles (header_cases.json, shared with gincommon and fastapicommon)', () => {
  it.each(cases.roles_cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(parseRoles(c.raw)).toEqual(c.expected ?? []);
  });

  it.each(cases.roles_length_cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(parseRoles('r'.repeat(c.length))).toEqual(c.valid ? ['r'.repeat(c.length)] : []);
  });

  it('fails closed above 64 distinct roles or 4096 bytes, counting distinct valid roles only', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `role${i}`);
    expect(parseRoles(many(64))).toHaveLength(64);
    expect(parseRoles(many(65))).toEqual([]);
    expect(parseRoles([...many(64), 'role0', 'bad role'])).toHaveLength(64);
    expect(parseRoles(`a,${'x'.repeat(4095)}`)).toEqual([]);
  });

  it('accepts a list (the session context) as well as a header string', () => {
    expect(parseRoles([' admin ', 'admin', 'bad role', 'member'])).toEqual(['admin', 'member']);
    expect(parseRoles(undefined)).toEqual([]);
    expect(parseRoles([1, 'ok'] as unknown as string[])).toEqual(['ok']);
  });
});

describe('roleMapAuthorizer', () => {
  const a = roleMapAuthorizer({
    tenant_admin: ['*:*'],
    approver: ['approve:tender', 'read:*'],
    member: ['read:tender'],
  });

  it('allows when any role grants a matching permission, with * on either side', () => {
    expect(a.authorize({ roles: ['member'] }, 'read', 'tender')).toBe(true);
    expect(a.authorize({ roles: ['member'] }, 'approve', 'tender')).toBe(false);
    expect(a.authorize({ roles: ['member', 'approver'] }, 'approve', 'tender')).toBe(true);
    expect(a.authorize({ roles: ['approver'] }, 'read', 'invoice')).toBe(true);
    expect(a.authorize({ roles: ['tenant_admin'] }, 'delete', 'anything')).toBe(true);
    expect(a.authorize({ roles: ['unknown'] }, 'read', 'tender')).toBe(false);
    expect(a.authorize(undefined, 'read', 'tender')).toBe(false);
  });

  it('rejects malformed permissions', () => {
    expect(() => roleMapAuthorizer({ r: ['read'] as never })).toThrow(TypeError);
    expect(() => roleMapAuthorizer({ r: ['a:b:c'] as never })).toThrow(TypeError);
    expect(() => roleMapAuthorizer({ r: ['read: tender'] as never })).toThrow(TypeError);
    expect(() => roleMapAuthorizer({ r: 'read:tender' as never })).toThrow(TypeError);
  });
});

describe('hasPermission', () => {
  it('denies before the shell sets an authorizer and a subject', () => {
    expect(hasPermission('read', 'tender')).toBe(false);
    setAuthzSubject({ roles: ['member'] });
    expect(hasPermission('read', 'tender')).toBe(false); // still denyAll
  });

  it('uses the installed authorizer and subject', () => {
    setAuthorizer(roleMapAuthorizer({ member: ['read:tender'] }));
    setAuthzSubject({ roles: ['member'], tenantId: 't1' });
    expect(hasPermission('read', 'tender')).toBe(true);
    expect(getRuntime().authzSubject).toEqual({ roles: ['member'], tenantId: 't1' });
    setAuthzSubject(undefined);
    expect(hasPermission('read', 'tender')).toBe(false);
  });

  it('re-parses the subject roles with the backend rule, so an oversized list grants nothing', () => {
    setAuthorizer(roleMapAuthorizer({ member: ['read:tender'] }));
    setAuthzSubject({ roles: ['member', ...Array.from({ length: 70 }, (_, i) => `r${i}`)] });
    expect(hasPermission('read', 'tender')).toBe(false);
  });

  it('fails closed when the authorizer throws or answers anything but true', () => {
    setAuthzSubject({ roles: ['member'] });
    setAuthorizer({ authorize: () => { throw new Error('bug'); } });
    expect(hasPermission('read', 'tender')).toBe(false);
    setAuthorizer({ authorize: () => 'yes' } as unknown as Authorizer);
    expect(hasPermission('read', 'tender')).toBe(false);
    setAuthorizer(undefined as unknown as Authorizer);
    expect(hasPermission('read', 'tender')).toBe(false);
    expect(denyAll.authorize({ roles: ['x'] }, 'a', 'b')).toBe(false);
  });
});
