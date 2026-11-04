// The session context (IAM P-35) with bounded retries, and the store the shell's provider reads it from.
// Without it the subject is deny-all and only platform flags apply, so one transient failure at boot
// must not last for the page's life: the shell renders deny-all and keeps trying in the background.
import type { SessionContext } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import { NetworkError, TimeoutError, isProblemError } from '@bcbp-solutions-fzc-llc/frontend-sdk/problem';

/** Network failures, timeouts, 429 and 5xx are worth another try; any other answer is final. */
export function isTransient(e: unknown): boolean {
  if (e instanceof NetworkError || e instanceof TimeoutError) return true;
  return isProblemError(e) && (e.status === 429 || e.status >= 500);
}

export interface RetryOptions {
  /** Further tries after the first failure. Default 3. */
  attempts?: number;
  /** The delay before the first retry; it doubles each time. Default 1000 ms. */
  baseDelayMs?: number;
  /** Stops the retries (sign-out, sign-in again). */
  signal?: AbortSignal;
  /** Each failed retry, for the log. */
  onError?: (e: unknown, attempt: number) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Retries `load` after a failed first load: up to `attempts` times, waiting baseDelayMs, then twice
 * that, and so on. Resolves to the context, or undefined when the tries run out, an error is not
 * transient, or `signal` aborts.
 */
export async function retrySessionContext(load: (signal?: AbortSignal) => Promise<SessionContext>, o: RetryOptions = {}): Promise<SessionContext | undefined> {
  const attempts = o.attempts ?? 3;
  let delay = o.baseDelayMs ?? 1000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delay, o.signal);
    if (o.signal?.aborted) return undefined;
    try {
      const context = await load(o.signal);
      return o.signal?.aborted ? undefined : context;
    } catch (e) {
      if (o.signal?.aborted) return undefined;
      o.onError?.(e, attempt);
      if (!isTransient(e)) return undefined;
    }
    delay *= 2;
  }
  return undefined;
}

/** A value React reads with useSyncExternalStore: the shell's session context, set when a retry succeeds. */
export interface Store<T> {
  get(): T;
  set(v: T): void;
  subscribe(l: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(v) {
      value = v;
      for (const l of [...listeners]) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
