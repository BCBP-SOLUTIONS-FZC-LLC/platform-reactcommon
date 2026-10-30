// Parsing error responses into ProblemError (design doc §C1 /problem "Parse rules"), mirroring
// gincommon's client decoder (FromResponse / Decode / UnmarshalJSON). contracts/fixtures/
// problem_bodies.json holds real gincommon and fastapicommon responses with that decoder's
// result; the SDK must produce the same. Where the design doc chose otherwise, it is noted below.
import { GATEWAY_DENY_CODES as DENY_CODES } from '../internal/generated/gateway-deny-codes.ts';
import { PROBLEM } from '../internal/generated/problem.ts';
import { ProblemError, type FieldError, type ProblemDetails } from './errors.ts';
import { DEFAULT_TYPE_BASE, statusTitleAndCode, typeForStatus } from './types.ts';

/** Gateway (ext_authz) deny codes, sent as the problem's `errorCode` (design doc §D6 H); generated from iam-authz-enrichment. */
export const GATEWAY_DENY_CODES = DENY_CODES;
export type GatewayDenyCode = (typeof GATEWAY_DENY_CODES)[number];

/** `p.errorCode` when it is one of the gateway's deny codes, else undefined. */
export function gatewayDenyCode(p: ProblemError): GatewayDenyCode | undefined {
  const code = p.errorCode;
  return code !== undefined && (GATEWAY_DENY_CODES as readonly string[]).includes(code) ? (code as GatewayDenyCode) : undefined;
}

const STANDARD = new Set<string>(PROBLEM.rules.standardMembers);
const STANDARD_FOLDED = new Set<string>(PROBLEM.rules.standardMembers.map((m) => m.toLowerCase()));
const STRING_MEMBERS = ['type', 'title', 'detail', 'instance', 'traceId', 'errorCode', 'tenantId', 'timestamp'] as const;
const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/;

// RFC 9110 media type with parameters; like Go's mime.ParseMediaType, a malformed parameter
// makes the whole value invalid.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const PARAM = new RegExp(`^\\s*${TOKEN}\\s*=\\s*(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*")\\s*$`);

/** Whether a Content-Type is application/problem+json (case-insensitive, parameters ignored). */
export function isProblemContentType(value: string | null | undefined): boolean {
  if (!value) return false;
  const [mediaType, ...params] = value.split(';');
  if (mediaType!.trim().toLowerCase() !== PROBLEM.contentType) return false;
  return params.every((p) => PARAM.test(p));
}

/** The body as text, or undefined when it is larger than gincommon's MaxClientBodyBytes. */
async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROBLEM.rules.maxClientBodyBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** One validationErrors entry; undefined when Go's decoder would reject it. */
function toFieldError(entry: Record<string, unknown>): FieldError | undefined {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'field' || k === 'message' || k === 'code') continue;
    out[k] = v; // members beyond field and message are kept (Go drops them; design doc §0 row 3)
  }
  for (const k of ['field', 'message'] as const) {
    const v = entry[k];
    if (v !== undefined && v !== null && typeof v !== 'string') return undefined;
    out[k] = typeof v === 'string' ? v : '';
  }
  if (typeof entry.code === 'string') out.code = entry.code;
  return { ...out } as unknown as FieldError;
}

/**
 * The problem in a decoded body, or undefined when Go's decoder would fail on it (not an object,
 * a standard member of the wrong JSON type). Standard members are matched case-sensitively; a
 * member that differs from one only by case is dropped, neither used nor kept as an extension
 * (design doc: Go's encoding/json would use it).
 */
function toDetails(body: unknown, responseStatus: number): ProblemDetails | undefined {
  if (!isRecord(body)) return undefined;
  const d: Record<string, unknown> = {};
  for (const m of STRING_MEMBERS) {
    const v = has(body, m) ? body[m] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return undefined;
    d[m] = v;
  }
  const status = has(body, 'status') ? body.status : undefined;
  if (status !== undefined && status !== null && !(typeof status === 'number' && Number.isInteger(status))) return undefined;
  // A missing (or zero) status takes the response status, as FromResponse does.
  d.status = typeof status === 'number' && status !== 0 ? status : responseStatus;
  // RFC 9457 §3.1.1: an absent type means about:blank.
  d.type ??= 'about:blank';
  d.title ??= '';

  const rawErrors = has(body, 'validationErrors') ? body.validationErrors : undefined;
  if (rawErrors !== undefined && rawErrors !== null) {
    if (!Array.isArray(rawErrors)) return undefined;
    const errors: FieldError[] = [];
    for (const entry of rawErrors) {
      if (entry === null) continue;
      if (!isRecord(entry)) return undefined;
      const fe = toFieldError(entry);
      if (!fe) return undefined;
      errors.push(fe);
    }
    d.validationErrors = errors;
  }

  const extensions = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) {
    if (STANDARD.has(k) || STANDARD_FOLDED.has(k.toLowerCase())) continue;
    extensions[k] = v;
  }
  d.extensions = extensions;
  return d as unknown as ProblemDetails;
}

/** A problem for an error response that carried no usable problem body. The body is never surfaced. */
function syntheticProblem(status: number, traceIdHeader: string | null, requestId: string | undefined): ProblemError {
  const t = typeForStatus(status);
  const { title, code } = t ?? statusTitleAndCode(status);
  const traceId = traceIdHeader?.trim().toLowerCase();
  return new ProblemError(
    {
      type: t ? `${DEFAULT_TYPE_BASE}/${t.id}` : 'about:blank',
      title,
      status,
      errorCode: code,
      ...(traceId && TRACE_ID.test(traceId) ? { traceId } : {}),
      extensions: {},
    },
    { synthetic: true, ...(requestId === undefined ? {} : { requestId }) },
  );
}

/**
 * Parses an error response. An application/problem+json body becomes a ProblemError with its
 * members; anything else (another content type, an unreadable, oversized or malformed body)
 * becomes a synthetic problem built from the status, with the trace id from X-Trace-ID.
 * `requestId` comes from the X-Request-ID response header, else `init.requestId`.
 */
export async function parseProblemResponse(res: Response, init?: { requestId?: string }): Promise<ProblemError> {
  const requestId = res.headers.get('x-request-id') || init?.requestId || undefined;
  const traceHeader = res.headers.get('x-trace-id');
  if (!isProblemContentType(res.headers.get('content-type'))) {
    await res.body?.cancel().catch(() => {});
    return syntheticProblem(res.status, traceHeader, requestId);
  }
  let text: string | undefined;
  try {
    text = await readCapped(res);
  } catch {
    text = undefined;
  }
  if (text === undefined) return syntheticProblem(res.status, traceHeader, requestId);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return syntheticProblem(res.status, traceHeader, requestId);
  }
  const details = toDetails(body, res.status);
  if (!details) return syntheticProblem(res.status, traceHeader, requestId);
  return new ProblemError(details, requestId === undefined ? {} : { requestId });
}
