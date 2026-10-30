// Log sanitisation with parity to platform-gincommon's log_sanitizer.go (design doc §0 row 4,
// §C5 row 12). Every list and limit comes from contracts/redaction.json, generated from the Go
// source; contracts/fixtures/redaction_cases.json runs here, in fastapicommon and (once gincommon
// exports its sanitizer) in Go. Two deliberate differences, both stricter:
// - sanitizeString also removes U+2028 and U+2029 (the fixture's `expectedSdk`);
// - sanitizeFields recurses into nested objects and arrays, which the flat backend maps never have.
import { REDACTION } from '../internal/generated/redaction.ts';

const EXACT_KEYS: ReadonlySet<string> = new Set(REDACTION.exactKeys);

// Go strings.TrimSpace: unicode.IsSpace (ASCII whitespace, U+0085, U+00A0, Zs, U+2028, U+2029).
// Not String.prototype.trim, which also trims U+FEFF and keeps U+0085.
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\p{Zs}\\u2028\\u2029]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'gu');

/** Whether a field name holds a secret: exact names, sensitive substrings, `key` and `*_key`. */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  const k = key.replace(GO_TRIM, '').toLowerCase();
  if (k === '') return false;
  if (EXACT_KEYS.has(k)) return true;
  if (REDACTION.substrings.some((s) => k.includes(s))) return true;
  return k === 'key' || k.endsWith(REDACTION.keySuffix);
}

const STRIPPED = /[\p{Cc}\u2028\u2029]/gu;

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3; // includes lone surrogates, encoded as U+FFFD (3 bytes)
  return 4;
}

/** `s` truncated to at most `maxBytes` UTF-8 bytes, never splitting a character. */
function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    bytes += utf8Length(ch.codePointAt(0)!);
    if (bytes > maxBytes) return s.slice(0, end);
    end += ch.length;
  }
  return s;
}

/**
 * Removes Unicode control characters (Cc) and U+2028/U+2029, then truncates to 256 UTF-8 bytes
 * at a character boundary, so untrusted text cannot inject or flood log lines.
 */
export function sanitizeString(s: string): string {
  const text = typeof s === 'string' ? s : String(s);
  return truncateUtf8(text.replace(STRIPPED, ''), REDACTION.stringMaxBytes);
}

const CIRCULAR = '[Circular]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out = value.map((v) => redact(v, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTION.redacted : redact(v, seen);
    }
    seen.delete(value);
    return out;
  }
  return value; // primitives and class instances (Date, Error, …) pass through unchanged
}

/**
 * A copy of `f` in which the value of every sensitive key, at any depth, is '[REDACTED]',
 * whatever its type. Arrays and plain objects are copied; other values are passed through; a
 * reference cycle becomes '[Circular]'. `f` is never mutated. String values are not sanitised
 * here: /logging applies sanitizeString afterwards.
 */
export function sanitizeFields(f: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(f)) return {};
  return redact(f, new WeakSet()) as Record<string, unknown>;
}
