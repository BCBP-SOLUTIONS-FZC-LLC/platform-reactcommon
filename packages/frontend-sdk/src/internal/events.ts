// Change notifications between subpaths (design doc §C1 "Dependency rules": cross-module wiring goes
// through the PlatformRuntime). A subpath that owns some state emits its topic after a change; /react
// subscribes and re-renders. Listeners live on the runtime, so every SDK copy on the page shares them.
import { getRuntime } from './runtime.ts';

/**
 * i18n: locale or catalogs; flags: the provider; authz: authorizer or subject; read-only: a DENY_TENANT_READ_ONLY
 * was seen; session: initializeAuth installed an identity provider (its own subscribe carries the state changes).
 */
export type RuntimeTopic = 'i18n' | 'flags' | 'authz' | 'read-only' | 'session';

function listeners(topic: RuntimeTopic): Set<() => void> {
  const events = getRuntime().events;
  let set = events.get(topic);
  if (!set) {
    set = new Set();
    events.set(topic, set);
  }
  return set;
}

export function emitRuntime(topic: RuntimeTopic): void {
  for (const l of [...listeners(topic)]) {
    try {
      l();
    } catch {
      // one listener's failure never stops the others
    }
  }
}

export function subscribeRuntime(topic: RuntimeTopic, l: () => void): () => void {
  listeners(topic).add(l);
  return () => listeners(topic).delete(l);
}
