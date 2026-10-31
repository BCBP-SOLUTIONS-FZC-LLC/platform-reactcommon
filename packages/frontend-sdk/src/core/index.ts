/**
 * Page identity, correlation ids, consent and log sanitisation: the base every other subpath
 * builds on. Design contract: docs/design/frontend-sdk-design.md §C1 `/core`.
 *
 * @packageDocumentation
 */
export {
  DOMAINS,
  ENVIRONMENTS,
  IdentityMismatchError,
  InvalidIdentityError,
  NotInitializedError,
  getIdentity,
  initializeCore,
  isInitialized,
  type CoreIdentity,
  type CoreIdentityInput,
  type Domain,
  type Environment,
  type ServiceName,
} from './identity.ts';
export { getSessionId, newRequestId } from './correlation.ts';
export { hasConsent, setConsentProvider, type ConsentCategory, type ConsentProvider } from './consent.ts';
export { isSensitiveKey, sanitizeFields, sanitizeString } from './sanitize.ts';
export { scrubSecrets } from './scrub.ts';

/** Per-MFE scope: every log, span and metric from a remote is tagged with `mfe`. */
export interface MfeScope {
  readonly mfe: string;
}
