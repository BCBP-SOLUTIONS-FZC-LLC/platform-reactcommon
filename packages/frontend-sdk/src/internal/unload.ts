// The page's last chance to send (pagehide): only fetch keepalive and sendBeacon requests outlive a
// closing tab, and the browser budgets their bodies together, 64 KiB per page in flight. Signals that
// sent on their own each took the whole budget, so the second was refused (known browser bug 1: the
// spans' keepalive request left the log beacons nothing). One listener per page now hands out one
// budget, in priority order: logs first (errors and essential warnings are what operations see without
// consent; docs/observability/tier1-ratification.md §5), then spans with what is left.
import { getRuntime } from './runtime.ts';

/** The shared budget, under the browser's 64 KiB for headers and the request line. */
export const PAGE_KEEPALIVE_BYTES = 60 * 1024;

export interface UnloadSender {
  /** Lower goes first. */
  readonly priority: number;
  /**
   * Starts its requests now, synchronously (a closing tab may never run a later microtask), within
   * `budget` bytes of body, and returns the bytes it used.
   */
  send(budget: number): number;
}

interface UnloadState {
  senders: Set<UnloadSender>;
  listener: () => void;
}

function state(): UnloadState {
  const rt = getRuntime();
  if (!rt.unload) {
    const s: UnloadState = { senders: new Set(), listener: () => drain(s) };
    rt.unload = s;
  }
  return rt.unload as UnloadState;
}

/** Each sender in priority order with what the earlier ones left; a throwing sender never stops the rest. */
function drain(s: UnloadState): void {
  let left = PAGE_KEEPALIVE_BYTES;
  for (const sender of [...s.senders].sort((a, b) => a.priority - b.priority)) {
    try {
      left -= Math.min(left, Math.max(0, sender.send(left)));
    } catch {
      // telemetry never breaks a page that is closing
    }
  }
}

/** Registers `sender` for the page's pagehide; returns the unregister. */
export function onUnload(sender: UnloadSender): () => void {
  const s = state();
  if (s.senders.size === 0) globalThis.addEventListener?.('pagehide', s.listener);
  s.senders.add(sender);
  return () => {
    s.senders.delete(sender);
    if (s.senders.size === 0) globalThis.removeEventListener?.('pagehide', s.listener);
  };
}
