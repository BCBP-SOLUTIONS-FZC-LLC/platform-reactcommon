// Page reloads the SDK starts (a chunk-load error after a deploy, useAppUpdate().reload): the listeners run
// first, synchronously, so a draft can be kept (useBeforeAuthRedirect subscribes to these and to /auth's
// redirects). Shared through the runtime, so every SDK copy on the page sees one set.
import { getRuntime } from './runtime.ts';

// A runtime an older SDK copy of the same major created has no set yet.
const listeners = (): Set<() => void> => ((getRuntime() as { beforeReload?: Set<() => void> }).beforeReload ??= new Set());

/** Registers `l` to run before the SDK reloads the page; returns the unsubscribe. */
export function onBeforeReload(l: () => void): () => void {
  const set = listeners();
  set.add(l);
  return () => void set.delete(l);
}

/** Runs the listeners (a throwing one never stops the others or the reload), then reloads the page. */
export function reloadPage(): void {
  for (const l of [...listeners()]) {
    try {
      l();
    } catch {
      // a listener that fails must not keep the page on a broken build
    }
  }
  globalThis.location?.reload();
}
