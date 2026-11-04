// Log redaction (design doc §C1 /logging): sanitizeFields, then on every string value URL queries and
// fragments removed, sanitizeString, and scrubbing of JWT- and Bearer-shaped substrings; the message the same way.
import { isSensitiveKey, sanitizeFields, sanitizeString, scrubSecrets } from '../core/index.ts';
import { stripUrlQueries } from '../internal/urls.ts';

export { scrubSecrets } from '../core/index.ts';

const REDACTED = '[REDACTED]';

/** URL queries and fragments removed, sanitizeString (controls, 256 bytes), then scrubSecrets: what every logged string goes through. */
export function cleanString(s: string): string {
  return scrubSecrets(sanitizeString(stripUrlQueries(s)));
}

/** A log attribute value: OTLP AnyValue (primitives, arrays, maps). */
export type LogValue = string | number | boolean | null | LogValue[] | { [k: string]: LogValue };

function mapKey(k: unknown): string {
  if (typeof k === 'string') return k;
  try {
    return cleanString(String(k));
  } catch {
    return cleanString(Object.prototype.toString.call(k)); // e.g. an object without toString
  }
}

/**
 * A record's attributes are at most about this many bytes (strings at their cleaned length, 8 per other
 * value): a large array or object would otherwise make one record bigger than the page's whole unload
 * budget. Past it, a value becomes TRUNCATED and the collections stop.
 */
export const ATTRIBUTES_MAX_BYTES = 8 * 1024;
const TRUNCATED = '[TRUNCATED]';

interface Walk {
  seen: WeakSet<object>;
  /** Bytes of attribute data left (ATTRIBUTES_MAX_BYTES). */
  left: number;
}

function toLogValue(v: unknown, walk: Walk): LogValue | undefined {
  if (walk.left <= 0) return TRUNCATED;
  const value = toLogValueOnce(v, walk);
  if (typeof value === 'string') walk.left -= value.length;
  else if (value !== undefined && (typeof value !== 'object' || value === null)) walk.left -= 8;
  return value;
}

function toLogValueOnce(v: unknown, walk: Walk): LogValue | undefined {
  const { seen } = walk;
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
    if (Array.isArray(v) || v instanceof Set) {
      const items: LogValue[] = [];
      for (const x of v as Iterable<unknown>) {
        if (walk.left <= 0) {
          items.push(TRUNCATED);
          break;
        }
        items.push(toLogValue(x, walk) ?? null);
      }
      out = items;
    } else {
      // A Map logs as an object of its entries; a non-string key is stringified (and cleaned).
      const entries = v instanceof Map ? Array.from(v as Map<unknown, unknown>, ([k, x]) => [mapKey(k), x] as const) : Object.entries(v);
      const o: Record<string, LogValue> = {};
      for (const [k, x] of entries) {
        if (walk.left <= 0) {
          o[k] = TRUNCATED;
          break;
        }
        walk.left -= k.length;
        // sanitizeFields (gincommon parity) passes class instances through; their keys are checked here.
        if (isSensitiveKey(k)) {
          o[k] = REDACTED;
          continue;
        }
        const lv = toLogValue(x, walk);
        if (lv !== undefined) o[k] = lv;
      }
      out = o;
    }
    seen.delete(v);
    return out;
  }
  return undefined;
}

/** Caller attributes, redacted: sensitive keys at any depth, then every string cleaned; at most ATTRIBUTES_MAX_BYTES. */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, LogValue> {
  const redacted = sanitizeFields(attrs);
  const out: Record<string, LogValue> = {};
  const walk: Walk = { seen: new WeakSet<object>(), left: ATTRIBUTES_MAX_BYTES };
  for (const [k, v] of Object.entries(redacted)) {
    walk.left -= k.length;
    const lv = toLogValue(v, walk);
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
/** How many causes deep, and how long the joined chain may be. */
const CAUSE_DEPTH = 3;
const CAUSE_MAX_BYTES = 1024;

/**
 * The error's cause chain as "Type: message ← Type: message", each link cleaned like a message (a
 * remote's "failed to evaluate" says nothing without the shared-module error under it). Cycles end it.
 */
function causeChain(e: Error): string | undefined {
  const links: string[] = [];
  const seen = new Set<unknown>([e]);
  for (let c: unknown = e.cause; c !== undefined && c !== null && links.length < CAUSE_DEPTH && !seen.has(c); c = (c as { cause?: unknown }).cause) {
    seen.add(c);
    if (!(c instanceof Error)) {
      const s = serializeError(c);
      links.push(`${s.name}: ${s.message}`);
      break;
    }
    links.push(`${cleanString(c.name || 'Error')}: ${cleanString(c.message)}`);
  }
  return links.length > 0 ? truncateBytes(links.join(' ← '), CAUSE_MAX_BYTES) : undefined;
}

export function serializeError(e: unknown): { name: string; message: string; stack?: string; cause?: string } {
  if (e instanceof Error) {
    const out: { name: string; message: string; stack?: string; cause?: string } = {
      name: cleanString(e.name || 'Error'),
      message: cleanString(e.message),
    };
    if (typeof e.stack === 'string' && e.stack !== '') {
      const stack = scrubSecrets(e.stack.replace(URL_QUERY, '$1').replace(/[\p{Cc}\u2028\u2029](?<!\n)/gu, ''));
      out.stack = truncateBytes(stack, STACK_MAX_BYTES);
    }
    const cause = causeChain(e);
    if (cause) out.cause = cause;
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
