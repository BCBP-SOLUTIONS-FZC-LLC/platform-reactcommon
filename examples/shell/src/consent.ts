// A stand-in for the consent management platform (CMP): essential telemetry always; telemetry and
// analytics once the user accepts. A real shell wires its CMP's API here.
import type { ConsentCategory, ConsentProvider } from '@platform/frontend-sdk/core';

const granted = new Set<ConsentCategory>(['essential']);
const listeners = new Set<() => void>();

export const cmp: ConsentProvider & { accept(categories: readonly ConsentCategory[]): void } = {
  has: (c) => granted.has(c),
  subscribe(l) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  accept(categories) {
    for (const c of categories) granted.add(c);
    for (const l of [...listeners]) l();
  },
};
