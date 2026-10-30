// Online state from the browser (navigator.onLine and the online/offline events).

/** Whether the browser reports a network connection. True outside a browser. */
export function isOnline(): boolean {
  return globalThis.navigator?.onLine ?? true;
}

/** Calls `l` with the new state on every online/offline change; returns an unsubscribe function. */
export function subscribeOnline(l: (online: boolean) => void): () => void {
  const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
  if (typeof target.addEventListener !== 'function') return () => {};
  const on = () => l(true);
  const off = () => l(false);
  target.addEventListener('online', on);
  target.addEventListener('offline', off);
  return () => {
    target.removeEventListener?.('online', on);
    target.removeEventListener?.('offline', off);
  };
}
