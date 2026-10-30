import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { SESSION_ID_STORAGE_KEY } from '../../src/internal/session.ts';
import { ForbiddenStorageKeyError, clearAllAppStorage, storage, workspaceNamespace } from '../../src/storage/index.ts';
import { FakeStorage } from '../core/helpers.ts';

let local: FakeStorage;
let session: FakeStorage;
const TENANT = '6f1c2a4e-1b2c-4d3e-8f40-0123456789ab';

beforeEach(() => {
  resetRuntimeForTests();
  local = new FakeStorage();
  session = new FakeStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  clearAllAppStorage(); // also empties the in-page fallback between tests
  getRuntime().storageNamespace = 'tenant-acme';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('workspaceNamespace', () => {
  it('is the realm for a paid workspace and trial:<tenant_id> for a trial one', () => {
    expect(workspaceNamespace({ realm: 'tenant-acme', trial: false })).toBe('tenant-acme');
    expect(workspaceNamespace({ realm: 'trial', trial: true }, TENANT.toUpperCase())).toBe(`trial:${TENANT}`);
  });

  it("is 'anon' without a valid tenant_id in the trial realm or for a malformed realm", () => {
    expect(workspaceNamespace({ realm: 'trial', trial: true })).toBe('anon');
    expect(workspaceNamespace({ realm: 'trial', trial: true }, 'not-a-uuid')).toBe('anon');
    expect(workspaceNamespace({ realm: 'Tenant:Acme', trial: false })).toBe('anon');
    expect(workspaceNamespace(undefined as never)).toBe('anon');
  });
});

describe('storage', () => {
  it('namespaces keys as <ns>:<appId>:<key> and round-trips JSON', () => {
    const s = storage('tenders');
    s.set('filters', { status: 'open', page: 2 });
    expect(local.getItem('tenant-acme:tenders:filters')).toBe('{"status":"open","page":2}');
    expect(s.get<{ page: number }>('filters')?.page).toBe(2);
    s.remove('filters');
    expect(s.get('filters')).toBeUndefined();
  });

  it('keeps workspaces apart: a key written in one is invisible in another', () => {
    storage('tenders').set('draft', 'acme draft');
    getRuntime().storageNamespace = `trial:${TENANT}`;
    expect(storage('tenders').get('draft')).toBeUndefined();
  });

  it('uses sessionStorage for the session area (drafts across a step-up redirect)', () => {
    storage('tenders', { area: 'session' }).set('draft:edit-1', { title: 'x' });
    expect(session.getItem('tenant-acme:tenders:draft:edit-1')).toBe('{"title":"x"}');
    expect(local.length).toBe(0);
  });

  it('refuses credential-like keys on every operation', () => {
    const s = storage('tenders');
    for (const key of ['access_token', 'refreshToken', 'password', 'session', 'api_key']) {
      expect(() => s.set(key, 'x')).toThrow(ForbiddenStorageKeyError);
      expect(() => s.get(key)).toThrow(ForbiddenStorageKeyError);
      expect(() => s.remove(key)).toThrow(ForbiddenStorageKeyError);
    }
    expect(local.length).toBe(0);
  });

  it('rejects bad app ids, keys and values', () => {
    expect(() => storage('Tenders')).toThrow(TypeError);
    expect(() => storage('tenders').set('', 1)).toThrow(TypeError);
    expect(() => storage('tenders').set('a\nb', 1)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => storage('tenders').set('x', cyclic)).toThrow('JSON');
    expect(() => storage('tenders').set('x', 10n)).toThrow(TypeError);
  });

  it("writes nothing before sign-in ('anon'), with one dev warning", () => {
    getRuntime().storageNamespace = 'anon';
    storage('tenders').set('a', 1);
    storage('tenders').set('b', 2);
    expect(local.length).toBe(0);
    expect(storage('tenders').get('a')).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('removes a key when set to undefined, and returns undefined for corrupt JSON', () => {
    const s = storage('tenders');
    s.set('a', 1);
    s.set('a', undefined);
    expect(local.getItem('tenant-acme:tenders:a')).toBeNull();
    local.setItem('tenant-acme:tenders:b', '{oops');
    expect(s.get('b')).toBeUndefined();
  });

  it('keeps values for the page when storage is full or unavailable', () => {
    local.failWrites = true;
    const s = storage('tenders');
    s.set('a', { v: 1 });
    expect(s.get('a')).toEqual({ v: 1 });
    local.failWrites = false;
    local.failReads = true;
    expect(s.get('a')).toEqual({ v: 1 });
    vi.stubGlobal('localStorage', undefined);
    s.set('b', 2);
    expect(s.get('b')).toBe(2);
  });

  it('a write that fails when storage is full never leaves the older stored value to shadow it', () => {
    storage('tenders').set('draft', 'v1');
    expect(local.getItem('tenant-acme:tenders:draft')).toBe('"v1"');
    local.failWrites = true; // QuotaExceededError from here on
    storage('tenders').set('draft', 'v2');
    expect(storage('tenders').get('draft')).toBe('v2');
    // A fresh handle in the same page (what a remount sees) reads the new value too.
    expect(storage('tenders').get('draft')).toBe('v2');
    expect(local.getItem('tenant-acme:tenders:draft')).toBeNull();
    // remove() and clear() still drop the page-only value.
    storage('tenders').remove('draft');
    expect(storage('tenders').get('draft')).toBeUndefined();
    storage('tenders').set('draft', 'v3');
    storage('tenders').clear();
    expect(storage('tenders').get('draft')).toBeUndefined();
    // Storage that also refuses removeItem: the value is still kept for the page.
    local.removeItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(() => storage('tenders').set('draft', 'v4')).not.toThrow();
    expect(storage('tenders').get('draft')).toBe('v4');
  });

  it('clear() removes only this app in this workspace and area', () => {
    storage('tenders').set('a', 1);
    storage('tenders').set('b', 2);
    storage('iam-admin').set('a', 3);
    storage('tenders', { area: 'session' }).set('a', 4);
    getRuntime().storageNamespace = 'tenant-globex';
    storage('tenders').set('a', 5);
    getRuntime().storageNamespace = 'tenant-acme';
    storage('tenders').clear();
    expect([...Array(local.length).keys()].map((i) => local.key(i)).sort()).toEqual(['tenant-acme:iam-admin:a', 'tenant-globex:tenders:a']);
    expect(session.getItem('tenant-acme:tenders:a')).toBe('4');
  });
});

describe('clearAllAppStorage', () => {
  it('removes every SDK app key in both areas and keeps the session id and foreign keys', () => {
    storage('tenders').set('a', 1);
    getRuntime().storageNamespace = `trial:${TENANT}`;
    storage('iam-admin', { area: 'session' }).set('b', 2);
    local.setItem(SESSION_ID_STORAGE_KEY, '6f1c2a4e-1b2c-4d3e-8f40-0123456789ab');
    local.setItem('@platform/frontend-sdk:workspaces', '[]');
    local.setItem('other-lib:setting', 'x');
    local.setItem('i18nextLng', 'ar');
    clearAllAppStorage();
    expect([...Array(local.length).keys()].map((i) => local.key(i)).sort()).toEqual(
      ['@platform/frontend-sdk:workspaces', SESSION_ID_STORAGE_KEY, 'i18nextLng', 'other-lib:setting'].sort(),
    );
    expect(session.length).toBe(0);
  });

  it('also drops values kept in the page fallback', () => {
    local.failWrites = true;
    storage('tenders').set('a', 1);
    clearAllAppStorage();
    expect(storage('tenders').get('a')).toBeUndefined();
  });
});

describe('storage without browser storage', () => {
  it('falls back to the page when reading localStorage itself throws (blocked site data)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const s = storage('tenders');
    s.set('a', { v: 1 });
    expect(s.get('a')).toEqual({ v: 1 });
    expect(local.length).toBe(0); // kept for this page only
    s.remove('a');
    expect(s.get('a')).toBeUndefined();
  });

  it('clear() drops only this app and workspace from the page fallback when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    storage('tenders').set('a', 1);
    storage('iam-admin').set('a', 2);
    getRuntime().storageNamespace = 'tenant-globex';
    storage('tenders').set('a', 3);
    getRuntime().storageNamespace = 'tenant-acme';
    storage('tenders').clear();
    expect(storage('tenders').get('a')).toBeUndefined();
    expect(storage('iam-admin').get('a')).toBe(2);
    getRuntime().storageNamespace = 'tenant-globex';
    expect(storage('tenders').get('a')).toBe(3);
  });

  it('clearAllAppStorage() clears the page fallback and the other area when one area is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    storage('tenders').set('a', 1);
    storage('tenders', { area: 'session' }).set('b', 2);
    clearAllAppStorage();
    expect(storage('tenders').get('a')).toBeUndefined();
    expect(session.length).toBe(0);
  });
});
