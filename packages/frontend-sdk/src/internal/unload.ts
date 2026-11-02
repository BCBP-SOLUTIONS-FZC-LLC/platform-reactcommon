// The page's last chance to send (pagehide): only fetch keepalive and sendBeacon requests outlive a
// closing tab, and the browser budgets their bodies together, 64 KiB per page in flight. Signals that
// sent on their own each took the whole budget, so the second was refused (known browser bug 1: the
// spans' keepalive request left the log beacons nothing). One listener per page now hands out one
// budget, in priority order: metrics first, which only reserves its small share (metricsShare)
// while it collects the interval asynchronously; then logs (errors and essential warnings are what
// operations see without consent; docs/observability/tier1-ratification.md §5); then spans with what is
// left. The page being hidden (visibilitychange, before pagehide on a close) runs the same senders in the
// same order through their `hide`; both phases draw on one ledger (keepaliveLeft, spendKeepalive).
import { getRuntime } from './runtime.ts';

/** The shared budget, under the browser's 64 KiB for headers and the request line. */
export const PAGE_KEEPALIVE_BYTES = 60 * 1024;

/**
 * The metrics interval's share of the budget, kept free by the logs and spans: metrics are collected
 * asynchronously (metrics.ts), so they send after the other two, and would otherwise find the budget
 * taken and fall back to a request that does not outlive a closing tab. Sized from the last interval
 * sent (x1.25), between these bounds; METRICS_SHARE_DEFAULT_BYTES before the first; 0 without metrics.
 */
export const METRICS_SHARE_MIN_BYTES = 1024;
export const METRICS_SHARE_MAX_BYTES = 8 * 1024;
export const METRICS_SHARE_DEFAULT_BYTES = 2 * 1024;

/**
 * How long a keepalive request sent when the page was hidden is counted against the budget. The browser
 * frees its share once the request completes; neither sendBeacon nor the page learns when, so a request
 * is assumed in flight for this long. Hidden → closed within it (the usual close: visibilitychange, then
 * pagehide) leaves pagehide only what the hidden phase did not use.
 */
export const KEEPALIVE_IN_FLIGHT_MS = 5_000;

export interface UnloadSender {
  /** Lower goes first. */
  readonly priority: number;
  /**
   * Starts its requests now, synchronously (a closing tab may never run a later microtask), within
   * `budget` bytes of body, and returns the bytes it used.
   */
  send(budget: number): number;
  /**
   * The page was hidden (it may come back, or be closing: visibilitychange comes before pagehide). Same
   * contract as send, in the same priority order: the order the signals were initialised in must not
   * decide who gets the budget (spans initialised first took it all, and the logs were left nothing).
   */
  hide?(budget: number): number;
}

interface UnloadState {
  senders: Set<UnloadSender>;
  listener: () => void;
  hideListener: () => void;
  /** Keepalive bodies sent recently (see KEEPALIVE_IN_FLIGHT_MS), oldest first. */
  spent: { at: number; bytes: number }[];
  /** Bytes held for a send still being prepared (reserveKeepalive). */
  reserved: number;
  /** The metrics interval's share (setMetricsShare); 0 while metrics are not exported. */
  metricsShare: number;
}

function state(): UnloadState {
  const rt = getRuntime();
  if (!rt.unload) {
    const s: UnloadState = {
      senders: new Set(),
      listener: () => drain(s, 'send'),
      hideListener: () => {
        if (globalThis.document?.visibilityState === 'hidden') drain(s, 'hide');
      },
      spent: [],
      reserved: 0,
      metricsShare: 0,
    };
    rt.unload = s;
  }
  return rt.unload as UnloadState;
}

/** What is left of the page's keepalive budget now, after the requests still assumed in flight and the reservations. */
export function keepaliveLeft(now: number = Date.now()): number {
  const s = state();
  while (s.spent.length > 0 && now - s.spent[0]!.at >= KEEPALIVE_IN_FLIGHT_MS) s.spent.shift();
  return Math.max(0, PAGE_KEEPALIVE_BYTES - s.reserved - s.spent.reduce((n, e) => n + e.bytes, 0));
}

/** The share the logs and spans leave the metrics interval (0 when metrics are not exported). */
export function metricsShare(): number {
  return state().metricsShare;
}

/**
 * metrics.ts: `lastBytes` is the size of the interval it last sent (undefined when it starts: the
 * default; 0 when it stops: no share).
 */
export function setMetricsShare(lastBytes: number | undefined): void {
  state().metricsShare =
    lastBytes === undefined ? METRICS_SHARE_DEFAULT_BYTES : lastBytes === 0 ? 0 : Math.min(METRICS_SHARE_MAX_BYTES, Math.max(METRICS_SHARE_MIN_BYTES, Math.ceil(lastBytes * 1.25)));
}

/**
 * Holds `bytes` of the budget for a send that is still being prepared (the metrics interval, collected
 * asynchronously: a pagehide may come first, and its senders must leave the share alone). Returns the
 * release, which the sender calls before it measures what is left and sends; a second call is a no-op.
 */
export function reserveKeepalive(bytes: number): () => void {
  const s = state();
  s.reserved += bytes;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    s.reserved -= bytes;
  };
}

/** Records `bytes` of keepalive body (a beacon or a keepalive fetch) sent now. */
export function spendKeepalive(bytes: number, now: number = Date.now()): void {
  if (bytes > 0) state().spent.push({ at: now, bytes });
}

/** Each sender in priority order with what the earlier ones (and the hidden phase) left; a throwing sender never stops the rest. */
function drain(s: UnloadState, phase: 'send' | 'hide'): void {
  for (const sender of [...s.senders].sort((a, b) => a.priority - b.priority)) {
    try {
      const run = phase === 'send' ? sender.send.bind(sender) : sender.hide?.bind(sender);
      if (!run) continue;
      const left = keepaliveLeft(); // after the earlier senders' spending and reservations
      spendKeepalive(Math.min(left, Math.max(0, run(left))));
    } catch {
      // telemetry never breaks a page that is closing
    }
  }
}

/** Registers `sender` for the page's pagehide (and, with `hide`, the page being hidden); returns the unregister. */
export function onUnload(sender: UnloadSender): () => void {
  const s = state();
  if (s.senders.size === 0) {
    globalThis.addEventListener?.('pagehide', s.listener);
    globalThis.document?.addEventListener?.('visibilitychange', s.hideListener);
  }
  s.senders.add(sender);
  return () => {
    s.senders.delete(sender);
    if (s.senders.size === 0) {
      globalThis.removeEventListener?.('pagehide', s.listener);
      globalThis.document?.removeEventListener?.('visibilitychange', s.hideListener);
    }
  };
}
