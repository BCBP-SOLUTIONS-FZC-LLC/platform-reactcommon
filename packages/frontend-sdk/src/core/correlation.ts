// Correlation ids (design doc §C1 /core).
import { uuidV4 } from '../internal/ids.ts';
import { getSessionId as sessionId } from '../internal/session.ts';

/** RUM session id: random, one per browser profile, rotated on logout and idle timeout. */
export function getSessionId(): string {
  return sessionId();
}

/**
 * A new request id: a v4 UUID, which satisfies the backend's x-request-id rule
 * (^[a-zA-Z0-9._-]+$, ≤ 128 bytes). One per logical call, reused across its retries.
 */
export function newRequestId(): string {
  return uuidV4();
}
