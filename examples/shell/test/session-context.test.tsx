// @vitest-environment happy-dom
// Review 2, item 2: the shell retries a failed session context (bounded, transient errors only) and its
// provider reads the locale and the context live (they were captured once at boot).
import { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import { initializeI18n, setLocale } from '@bcbp-solutions-fzc-llc/frontend-sdk/i18n';
import { NetworkError, ProblemError, TimeoutError } from '@bcbp-solutions-fzc-llc/frontend-sdk/problem';
import { useSessionContext } from '@bcbp-solutions-fzc-llc/frontend-sdk/react';
import { resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { ShellContext } from '../../../packages/frontend-sdk/src/react/context.ts';
import { ShellRoot } from '../src/ShellRoot';
import { createStore, isTransient, retrySessionContext } from '../src/session-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTEXT: SessionContext = { tenantId: 't-1', slug: 'acme', roles: ['preparator'], departments: [], featureFlags: [], readOnly: false };
const problem = (status: number) => new ProblemError({ type: 'about:blank', title: 'x', status, extensions: {} });

afterEach(() => {
  vi.useRealTimers();
  resetRuntimeForTests();
});

describe('isTransient', () => {
  it('is true for network failures, timeouts, 429 and 5xx; false for other answers', () => {
    expect(isTransient(new NetworkError(true, 'req-1'))).toBe(true);
    expect(isTransient(new TimeoutError(1000, 'req-1'))).toBe(true);
    expect(isTransient(problem(503))).toBe(true);
    expect(isTransient(problem(429))).toBe(true);
    expect(isTransient(problem(403))).toBe(false);
    expect(isTransient(new Error('bug'))).toBe(false);
  });
});

describe('retrySessionContext', () => {
  it('waits 1 s, 2 s, 4 s between tries and returns the first context it gets', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(problem(503)).mockRejectedValueOnce(problem(502)).mockResolvedValue(CONTEXT);
    const done = retrySessionContext(load);
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await done).toBe(CONTEXT);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('gives up after the bounded number of tries', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new NetworkError(true, 'req-1'));
    const errors: number[] = [];
    const done = retrySessionContext(load, { onError: (_e, n) => errors.push(n) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([1, 2, 3]);
  });

  it('stops on an answer that is not transient', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(problem(403));
    const done = retrySessionContext(load);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns at once for a signal already aborted, without waiting or loading (review 3)', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    stop.abort();
    const load = vi.fn().mockResolvedValue(CONTEXT);
    const added = vi.spyOn(stop.signal, 'addEventListener');
    expect(await retrySessionContext(load, { signal: stop.signal })).toBeUndefined(); // no timer needed to settle
    expect(load).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled(); // no listener left on a signal that will never fire again
  });

  it('removes its abort listener once a wait ends', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const removed = vi.spyOn(stop.signal, 'removeEventListener');
    const done = retrySessionContext(vi.fn().mockResolvedValue(CONTEXT), { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual(CONTEXT);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('stops when its signal aborts (sign-out), and drops a context that arrives after it', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const load = vi.fn().mockResolvedValue(CONTEXT);
    const done = retrySessionContext(load, { signal: stop.signal });
    stop.abort();
    expect(await done).toBeUndefined();
    expect(load).not.toHaveBeenCalled();

    const late = new AbortController();
    const slow = vi.fn(() => new Promise<SessionContext>((r) => setTimeout(() => r(CONTEXT), 500)));
    const result = retrySessionContext(slow, { signal: late.signal });
    await vi.advanceTimersByTimeAsync(1100);
    late.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeUndefined();
  });
});

describe('ShellRoot', () => {
  it('provides the current locale and session context, not the ones at first render', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    const store = createStore<SessionContext | undefined>(undefined);
    const seen: { locale?: string | undefined; context?: SessionContext | undefined } = {};
    function Probe() {
      seen.locale = useContext(ShellContext)?.locale;
      seen.context = useSessionContext();
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ShellRoot context={store} shell={{ switchWorkspace: async () => {} }}>
          <Probe />
        </ShellRoot>,
      ),
    );
    expect(seen).toEqual({ locale: 'en', context: undefined });

    await act(async () => setLocale('ar'));
    expect(seen.locale).toBe('ar');
    await act(async () => store.set(CONTEXT));
    expect(seen.context).toBe(CONTEXT);
    await act(async () => root.unmount());
  });
});
