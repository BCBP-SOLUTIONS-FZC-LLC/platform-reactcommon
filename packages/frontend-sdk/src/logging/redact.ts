// Log redaction (design doc §C1 /logging): sanitizeFields, then sanitizeString on every string
// value, then scrubbing of JWT- and Bearer-shaped substrings, then the message the same way.
import { isSensitiveKey, sanitizeFields, sanitizeString } from '../core/index.ts';

const REDACTED = '[REDACTED]';

// A JWT starts with the base64url of '{"' ("eyJ"). Matched with one, two or three segments, so a
// token cut short by the 256-byte limit is still caught.
const JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;

/** Replaces JWTs and `Bearer <token>` credentials inside free text. */
export function scrubSecrets(s: string): string {
  return s.replace(BEARER, `$1 ${REDACTED}`).replace(JWT, REDACTED);
}

/** sanitizeString (controls, 256 bytes) then scrubSecrets: what every logged string goes through. */
export function cleanString(s: string): string {
  return scrubSecrets(sanitizeString(s));
}

/** A log attribute value: OTLP AnyValue (primitives, arrays, maps). */
export type LogValue = string | number | boolean | null | LogValue[] | { [k: string]: LogValue };

function toLogValue(v: unknown, seen: WeakSet<object>): LogValue | undefined {
  if (typeof v === 'string') return cleanString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
  if (v instanceof Error) return serializeError(v) as unknown as LogValue;
  if (typeof v === 'object') {
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    let out: LogValue;
    if (Array.isArray(v)) {
      out = v.map((x) => toLogValue(x, seen) ?? null);
    } else {
      const o: Record<string, LogValue> = {};
      for (const [k, x] of Object.entries(v)) {
        // sanitizeFields (gincommon parity) passes class instances through; their keys are checked here.
        if (isSensitiveKey(k)) {
          o[k] = REDACTED;
          continue;
        }
        const lv = toLogValue(x, seen);
        if (lv !== undefined) o[k] = lv;
      }
      out = o;
    }
    seen.delete(v);
    return out;
  }
  return undefined;
}

/** Caller attributes, redacted: sensitive keys at any depth, then every string cleaned. */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, LogValue> {
  const redacted = sanitizeFields(attrs);
  const out: Record<string, LogValue> = {};
  const seen = new WeakSet<object>();
  for (const [k, v] of Object.entries(redacted)) {
    const lv = toLogValue(v, seen);
    if (lv !== undefined) out[k] = lv;
  }
  return out;
}

const STACK_MAX_BYTES = 4096;
// A URL in a stack frame, followed by its query string and/or fragment (which may carry tokens).
const URL_QUERY = /((?:https?|blob|file):\/\/[^\s?#)]*)[?#][^\s):]*/g;

function truncateBytes(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/\uFFFD$/, '');
}

/**
 * An error as log data: name, message (sanitised, secrets scrubbed) and stack (URL query strings
 * and fragments stripped, control characters other than newlines removed, at most 4 KiB).
 * Non-Error values become { name: their type, message: their text }.
 */
export function serializeError(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) {
    const out: { name: string; message: string; stack?: string } = {
      name: cleanString(e.name || 'Error'),
      message: cleanString(e.message),
    };
    if (typeof e.stack === 'string' && e.stack !== '') {
      const stack = scrubSecrets(e.stack.replace(URL_QUERY, '$1').replace(/[\p{Cc}\u2028\u2029](?<!\n)/gu, ''));
      out.stack = truncateBytes(stack, STACK_MAX_BYTES);
    }
    return out;
  }
  let text: string;
  try {
    text = typeof e === 'string' ? e : JSON.stringify(e) ?? String(e);
  } catch {
    text = String(e);
  }
  return { name: e === null ? 'null' : typeof e, message: cleanString(text) };
}
