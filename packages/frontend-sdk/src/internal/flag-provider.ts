// The page's flag provider on the runtime, swapped in one place: /flags' setFlagProvider and /auth's sign-out
// (which may not import /flags) both go through here, so a provider's subscription is always stopped.
import { emitRuntime } from './events.ts';
import { getRuntime } from './runtime.ts';

/** What the swap needs of a provider (/flags owns the full FlagProvider type). */
interface Watchable {
  subscribe?(l: () => void): () => void;
}

/**
 * Makes `p` the runtime's flag provider (undefined: runtime-config flags): stops the previous provider's
 * subscription (whichever SDK copy set it), subscribes to `p`'s changes, and emits 'flags' (/react re-renders).
 */
export function swapFlagProvider(p: Watchable | undefined): void {
  const rt = getRuntime();
  rt.stopFlagWatching?.();
  rt.stopFlagWatching = undefined;
  rt.flagProvider = p ?? undefined;
  if (p && typeof p.subscribe === 'function') rt.stopFlagWatching = p.subscribe(() => emitRuntime('flags'));
  emitRuntime('flags');
}
