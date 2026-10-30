// Consent (PDPL / GDPR; design doc §C1 /core). The shell installs its consent management
// platform as the provider before any telemetry is exported. Until then only essential is granted.
import { ESSENTIAL_ONLY_CONSENT, getRuntime } from '../internal/runtime.ts';

/** Consent categories: essential (always granted), telemetry (debug/info logs, traces), analytics. */
export type ConsentCategory = 'essential' | 'telemetry' | 'analytics';

/** The shell's consent management platform, as the SDK sees it. */
export interface ConsentProvider {
  /** Whether the user granted `category`. Must answer synchronously. */
  has(category: ConsentCategory): boolean;
  /** Calls `listener` whenever any answer may have changed; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Shell only. Replaces the provider; subscribers registered through the old one are not moved. */
export function setConsentProvider(p: ConsentProvider): void {
  getRuntime().consent = p ?? ESSENTIAL_ONLY_CONSENT;
}

/**
 * Whether `c` is granted. Essential is always granted: it covers what the app cannot run without
 * (errors, security warnings). Anything else fails closed: a provider that throws or answers
 * anything but `true` means no consent.
 */
export function hasConsent(c: ConsentCategory): boolean {
  if (c === 'essential') return true;
  try {
    return getRuntime().consent.has(c) === true;
  } catch {
    return false;
  }
}
