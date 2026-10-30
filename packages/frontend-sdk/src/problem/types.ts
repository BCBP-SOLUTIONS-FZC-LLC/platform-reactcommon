// The platform error type registry (design doc §C1 /problem, §C5 rows 3-5), generated from
// gincommon's PlatformTypes() and TypeForStatus.
import { PLATFORM_PROBLEM_TYPES, PROBLEM } from '../internal/generated/problem.ts';

/** An error type registry entry: a stable `{domain}/{name}` id with a fixed title, status and default code. */
export interface ProblemType {
  readonly domain: string;
  readonly name: string;
  /** `{domain}/{name}`, independent of the type base URI. */
  readonly id: `${string}/${string}`;
  readonly title: string;
  readonly status: number;
  /** Default errorCode (upper snake case). */
  readonly code: string;
}

/** The 15 platform types every service shares, in registry order (gincommon PlatformTypes()). */
export const PlatformProblemTypes: {
  readonly BadRequest: ProblemType;
  readonly ValidationFailed: ProblemType;
  readonly Unauthorized: ProblemType;
  readonly Forbidden: ProblemType;
  readonly NotFound: ProblemType;
  readonly MethodNotAllowed: ProblemType;
  readonly Conflict: ProblemType;
  readonly PayloadTooLarge: ProblemType;
  readonly UnsupportedMediaType: ProblemType;
  readonly BusinessRuleViolation: ProblemType;
  readonly RateLimitExceeded: ProblemType;
  readonly InternalError: ProblemType;
  readonly NotImplemented: ProblemType;
  readonly ServiceUnavailable: ProblemType;
  readonly GatewayTimeout: ProblemType;
} = Object.freeze(PLATFORM_PROBLEM_TYPES);

/** RFC 9457 media type. */
export const PROBLEM_CONTENT_TYPE = PROBLEM.contentType;
/** gincommon's DefaultTypeBase: type URIs are `{base}/{domain}/{name}`. */
export const DEFAULT_TYPE_BASE = PROBLEM.defaultTypeBase;

const SLUG = new RegExp(PROBLEM.rules.slugPattern);
const CODE = new RegExp(PROBLEM.rules.codePattern);

/**
 * Defines a domain error type with gincommon NewType's rules: domain and name are lower-case
 * kebab slugs, the `platform` domain is reserved, the title is not blank, the status is 4xx or
 * 5xx and the code is upper snake case. Throws a TypeError otherwise.
 */
export function defineProblemType(domain: string, name: string, title: string, status: number, code: string): ProblemType {
  const fail = (why: string): never => {
    throw new TypeError(`invalid problem type ${domain}/${name}: ${why}`);
  };
  if (typeof domain !== 'string' || !SLUG.test(domain)) fail(`domain ${JSON.stringify(domain)} is not a lower-case kebab slug`);
  if (domain === PROBLEM.platformDomain) fail(`domain "${domain}" is reserved for the platform types`);
  if (typeof name !== 'string' || !SLUG.test(name)) fail(`name ${JSON.stringify(name)} is not a lower-case kebab slug`);
  if (typeof title !== 'string' || title.trim() === '') fail('the title is empty');
  if (!Number.isInteger(status) || status < 400 || status > 599) fail(`status ${status} is not a 4xx or 5xx`);
  if (typeof code !== 'string' || !CODE.test(code)) fail(`code ${JSON.stringify(code)} is not upper snake case`);
  return Object.freeze({ domain, name, id: `${domain}/${name}` as const, title, status, code });
}

const PLATFORM_TYPES: readonly ProblemType[] = PROBLEM.types;

/**
 * The platform type for a bare HTTP error status, as gincommon's TypeForStatus picks it: 400 is
 * bad-request (not validation-failed), otherwise the first platform type with that status.
 * undefined when there is none (the server would send about:blank).
 */
export function typeForStatus(status: number): ProblemType | undefined {
  if (status === 400) return PlatformProblemTypes.BadRequest;
  return PLATFORM_TYPES.find((t) => t.status === status);
}

/** Title and code a server would send for `status` (about:blank types included): Go's TypeForStatus. */
export function statusTitleAndCode(status: number): { title: string; code: string } {
  const known = PROBLEM.typeForStatus.find((t) => t.status === status);
  if (known) return { title: known.title, code: known.code };
  return { title: 'Error', code: 'ERROR' }; // net/http has no text for this status
}
