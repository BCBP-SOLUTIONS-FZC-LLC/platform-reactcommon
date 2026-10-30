// The SDK's error model (design doc §C1 /problem): every failed call is a ProblemError (the
// server answered with an error status), a TimeoutError (the client deadline passed) or a
// NetworkError (no response). AbortedError is the caller's own cancellation and is not an ApiError.
import type { ProblemType } from './types.ts';

/** One entry of validationErrors. `code` is parsed when present; other members are kept. */
export interface FieldError {
  /** JSON path of the invalid field, e.g. `items[0].sku`. */
  readonly field: string;
  readonly message: string;
  readonly code?: string;
  readonly [ext: string]: unknown;
}

/** An RFC 9457 problem as the platform services send it. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly traceId?: string;
  readonly errorCode?: string;
  readonly tenantId?: string;
  readonly timestamp?: string;
  readonly validationErrors?: readonly FieldError[];
  /** Every top-level member that is not a standard one. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

// Recognises a ProblemError from any copy of the SDK on the page (instanceof would not).
const PROBLEM_ERROR_BRAND = Symbol.for('@platform/frontend-sdk/ProblemError');

/**
 * The type id: the last two path segments of an absolute type URI ("platform/not-found"), so it
 * does not depend on the organisation's type base. undefined for about:blank or a non-URI type.
 */
export function typeIdOf(type: string): string | undefined {
  let url: URL;
  try {
    url = new URL(type);
  } catch {
    return undefined;
  }
  if (url.protocol === 'about:') return undefined;
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join('/');
}

/** A problem response from the server, parsed (or synthesised from a non-problem error status). */
export class ProblemError extends Error implements ProblemDetails {
  override readonly name = 'ProblemError';
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly traceId?: string;
  readonly errorCode?: string;
  readonly tenantId?: string;
  readonly timestamp?: string;
  readonly validationErrors?: readonly FieldError[];
  readonly extensions: Readonly<Record<string, unknown>>;
  /** True when built from a response that was not application/problem+json (or not a valid one). */
  readonly synthetic: boolean;
  /** From the X-Request-ID response header (or the id the request was sent with). */
  readonly requestId?: string;
  /** Type id ("platform/not-found"), independent of the configured type base. */
  readonly typeId: string | undefined;

  constructor(details: ProblemDetails, options: { synthetic?: boolean; requestId?: string } = {}) {
    super(details.detail ?? details.title);
    this.type = details.type;
    this.title = details.title;
    this.status = details.status;
    // Optional members are only set when present, so the object mirrors the body.
    if (details.detail !== undefined) this.detail = details.detail;
    if (details.instance !== undefined) this.instance = details.instance;
    if (details.traceId !== undefined) this.traceId = details.traceId;
    if (details.errorCode !== undefined) this.errorCode = details.errorCode;
    if (details.tenantId !== undefined) this.tenantId = details.tenantId;
    if (details.timestamp !== undefined) this.timestamp = details.timestamp;
    if (details.validationErrors !== undefined) this.validationErrors = Object.freeze([...details.validationErrors]);
    this.extensions = Object.freeze({ ...details.extensions });
    this.synthetic = options.synthetic ?? false;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    this.typeId = typeIdOf(details.type);
    Object.defineProperty(this, PROBLEM_ERROR_BRAND, { value: true });
  }

  /** Whether this problem is of type `t`. Compares type ids, never title or detail. */
  is(t: ProblemType): boolean {
    return this.typeId !== undefined && this.typeId === t.id;
  }
}

/** The client-side deadline passed before a response arrived. A server timeout is a ProblemError (503). */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(
    readonly timeoutMs: number,
    readonly requestId: string,
  ) {
    super(`request ${requestId} timed out after ${timeoutMs} ms`);
  }
}

/** No response: offline, DNS, TLS, CORS or a dropped connection. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
  constructor(
    readonly offline: boolean,
    readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    super(offline ? `request ${requestId} not sent: the browser is offline` : `request ${requestId} failed: network error`, options);
  }
}

/** The caller aborted the request. Never logged as an error. */
export class AbortedError extends Error {
  override readonly name = 'AbortedError';
  constructor(message = 'the request was aborted') {
    super(message);
  }
}

/** Every way a call to a platform API can fail (an abort is not a failure). */
export type ApiError = ProblemError | TimeoutError | NetworkError;

/** Whether `e` is a ProblemError, from this or any other copy of the SDK. */
export function isProblemError(e: unknown): e is ProblemError {
  return typeof e === 'object' && e !== null && (e as Record<symbol, unknown>)[PROBLEM_ERROR_BRAND] === true;
}

/** Validation errors grouped by field path ('items[0].sku' kept as is), messages in order. */
export function toFieldErrorMap(p: ProblemError): Record<string, string[]> {
  // No prototype: a field path such as "__proto__" is an ordinary key, never the object's prototype.
  const out = Object.create(null) as Record<string, string[]>;
  for (const e of p.validationErrors ?? []) (out[e.field] ??= []).push(e.message);
  return out;
}
