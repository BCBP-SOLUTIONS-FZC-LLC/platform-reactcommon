import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionId, newRequestId } from '../../src/core/index.ts';
import { HEADERS } from '../../src/internal/generated/contracts.ts';
import { UUID_V4_PATTERN } from '../../src/internal/ids.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { SESSION_ID_STORAGE_KEY, rotateSessionId } from '../../src/internal/session.ts';
import { FakeStorage } from './helpers.ts';

let storage: FakeStorage;

beforeEach(() => {
  resetRuntimeForTests();
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

describe('newRequestId', () => {
  it("is a v4 UUID that satisfies the backend's x-request-id rule", () => {
    const pattern = new RegExp(HEADERS.patterns.requestId);
    const ids = new Set(Array.from({ length: 200 }, newRequestId));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_PATTERN);
      expect(id).toMatch(pattern);
      expect(id.length).toBeLessThanOrEqual(HEADERS.limits.requestIdMaxBytes);
    }
  });
});

describe('getSessionId', () => {
  it('creates one id, persists it and returns it on every call', () => {
    const id = getSessionId();
    expect(id).toMatch(UUID_V4_PATTERN);
    expect(storage.getItem(SESSION_ID_STORAGE_KEY)).toBe(id);
    expect(getSessionId()).toBe(id);
  });

  it('survives a reload: a fresh runtime reads the stored id', () => {
    const id = getSessionId();
    resetRuntimeForTests();
    expect(getSessionId()).toBe(id);
  });

  it("picks up another tab's rotation on the next read", () => {
    getSessionId();
    const otherTab = '6f1c2a4e-1b2c-4d3e-8f40-0123456789ab';
    storage.setItem(SESSION_ID_STORAGE_KEY, otherTab);
    expect(getSessionId()).toBe(otherTab);
  });

  it('replaces a stored value that is not a v4 UUID (it is sent as a header)', () => {
    storage.setItem(SESSION_ID_STORAGE_KEY, 'evil\r\nx-user-id: admin');
    const id = getSessionId();
    expect(id).toMatch(UUID_V4_PATTERN);
    expect(storage.getItem(SESSION_ID_STORAGE_KEY)).toBe(id);
  });

  it('keeps one stable per-page id when writes fail', () => {
    storage.failWrites = true;
    const id = getSessionId();
    expect(getSessionId()).toBe(id);
    expect(getRuntime().memorySessionId).toBe(id);
  });

  it('keeps one stable per-page id when storage access throws or is missing', () => {
    storage.failReads = true;
    const id = getSessionId();
    expect(getSessionId()).toBe(id);
    vi.stubGlobal('localStorage', undefined);
    expect(getSessionId()).toBe(id);
  });

  it('survives a localStorage getter that throws (blocked storage, sandboxed iframes)', () => {
    vi.unstubAllGlobals();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      const id = getSessionId();
      expect(id).toMatch(UUID_V4_PATTERN);
      expect(getSessionId()).toBe(id);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('rotateSessionId (internal, for /auth logout and idle timeout)', () => {
  it('starts a new session that every tab reads', () => {
    const before = getSessionId();
    const after = rotateSessionId();
    expect(after).not.toBe(before);
    expect(after).toMatch(UUID_V4_PATTERN);
    expect(storage.getItem(SESSION_ID_STORAGE_KEY)).toBe(after);
    expect(getSessionId()).toBe(after);
  });

  it('still rotates the per-page id when storage is unavailable', () => {
    storage.failWrites = true;
    const before = getSessionId();
    const after = rotateSessionId();
    expect(after).not.toBe(before);
    expect(getSessionId()).toBe(after);
  });
});
