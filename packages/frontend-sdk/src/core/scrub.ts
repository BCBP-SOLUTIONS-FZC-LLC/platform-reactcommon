// Value scrubbing for telemetry text (design doc §C1 /logging "Redaction order"): JWT- and
// Bearer-shaped substrings inside free text. Not part of gincommon's sanitizer (it redacts by key
// only); /logging applies it to every logged string and /tracing to span attributes and errors.

const REDACTED = '[REDACTED]';

// A JWT starts with the base64url of '{"' ("eyJ"). Matched with one, two or three segments, so a
// token cut short by the 256-byte limit is still caught.
const JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;

/** Replaces JWTs and `Bearer <token>` credentials inside free text with '[REDACTED]'. */
export function scrubSecrets(s: string): string {
  return s.replace(BEARER, `$1 ${REDACTED}`).replace(JWT, REDACTED);
}
