// Page identity (design doc §C1 /core, §0 rows 1-2): service, domain, environment and build
// version, validated with the rules every platform library shares (contracts/fixtures/
// identity_cases.json runs here and in go-probe identity-check).
import { REGISTRY_VOCAB } from '../internal/generated/contracts.ts';
import { getRuntime } from '../internal/runtime.ts';

/** Registry domain vocabulary, generated from gincommon's registry.json. */
export const DOMAINS = REGISTRY_VOCAB.domains;
/** Registry environment vocabulary: no aliases, so `production` is not one. */
export const ENVIRONMENTS = REGISTRY_VOCAB.environments;
/** A validated service name (^[a-z][a-z0-9_-]{0,62}$). */
export type ServiceName = string & { readonly __brand: 'ServiceName' };
/** A registry domain. */
export type Domain = (typeof DOMAINS)[number];
/** A registry environment. */
export type Environment = (typeof ENVIRONMENTS)[number];

/** What the shell passes to initializeCore: its build-time identity constants. */
export interface CoreIdentityInput {
  /** ^[a-z][a-z0-9_-]{0,62}$, matched exactly (not trimmed). */
  serviceName: string;
  /** ∈ DOMAINS, matched exactly. */
  domain: string;
  /** Trimmed and lower-cased, then ∈ ENVIRONMENTS. */
  environment: string;
  /** Trimmed; empty or absent becomes 'unknown'; then ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$. Never rewritten. */
  buildVersion?: string;
}

/** The page identity after validation and normalisation. Tags every log, span and metric. */
export interface CoreIdentity {
  readonly serviceName: ServiceName;
  readonly domain: Domain;
  readonly environment: Environment;
  readonly buildVersion: string;
}

/** initializeCore was given a value outside the registry rules; `field` names the first one. */
export class InvalidIdentityError extends Error {
  override readonly name = 'InvalidIdentityError';
  constructor(
    /** The first invalid field, in the backend's order: domain, serviceName, environment, buildVersion. */
    readonly field: keyof CoreIdentityInput,
    message: string,
  ) {
    super(message);
  }
}

/** initializeCore was called again with a different identity; a page has exactly one. */
export class IdentityMismatchError extends Error {
  override readonly name = 'IdentityMismatchError';
  constructor(
    /** The identity already in place. */
    readonly existing: CoreIdentity,
    /** The rejected one, after normalisation. */
    readonly attempted: CoreIdentity,
  ) {
    const field = (Object.keys(existing) as (keyof CoreIdentity)[]).find((k) => existing[k] !== attempted[k]);
    super(
      `@platform/frontend-sdk is already initialized with a different identity (${field}: ` +
        `${JSON.stringify(existing[field!])} ≠ ${JSON.stringify(attempted[field!])}). A page has one identity, set by the shell.`,
    );
  }
}

/** Thrown only by shell-only APIs (initialize*) called in the wrong order, never by consumer APIs. */
export class NotInitializedError extends Error {
  override readonly name = 'NotInitializedError';
}

const SERVICE_PATTERN = new RegExp(REGISTRY_VOCAB.servicePattern);
const VERSION_PATTERN = new RegExp(REGISTRY_VOCAB.versionPattern);
const DEFAULT_VERSION = 'unknown';

const isString = (v: unknown): v is string => typeof v === 'string';

/** Validates in the backend's order (domain, service, environment, version) and returns the first failure. */
function validate(input: CoreIdentityInput): CoreIdentity {
  const { serviceName, domain, environment, buildVersion } = input ?? ({} as CoreIdentityInput);
  if (!isString(domain) || !(DOMAINS as readonly string[]).includes(domain)) {
    throw new InvalidIdentityError('domain', `domain ${JSON.stringify(domain)} is not in the registry vocabulary ${JSON.stringify(DOMAINS)}`);
  }
  if (!isString(serviceName) || !SERVICE_PATTERN.test(serviceName)) {
    throw new InvalidIdentityError('serviceName', `serviceName ${JSON.stringify(serviceName)} does not match ${SERVICE_PATTERN.source}`);
  }
  const env = isString(environment) ? environment.trim().toLowerCase() : environment;
  if (!isString(env) || !(ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new InvalidIdentityError(
      'environment',
      `environment ${JSON.stringify(environment)} is not in the registry vocabulary ${JSON.stringify(ENVIRONMENTS)} (no aliases: use prod, not production)`,
    );
  }
  if (buildVersion !== undefined && !isString(buildVersion)) {
    throw new InvalidIdentityError('buildVersion', `buildVersion must be a string, got ${typeof buildVersion}`);
  }
  const version = buildVersion?.trim() || DEFAULT_VERSION;
  if (!VERSION_PATTERN.test(version)) {
    throw new InvalidIdentityError('buildVersion', `buildVersion ${JSON.stringify(buildVersion)} does not match ${VERSION_PATTERN.source}`);
  }
  return Object.freeze({
    serviceName: serviceName as ServiceName,
    domain: domain as Domain,
    environment: env as Environment,
    buildVersion: version,
  });
}

/**
 * Shell only: sets the page identity. Idempotent for an equal identity (after normalisation);
 * a different one throws IdentityMismatchError, because a page emits one identity.
 */
export function initializeCore(input: CoreIdentityInput): CoreIdentity {
  const attempted = validate(input);
  const rt = getRuntime();
  const existing = rt.identity as CoreIdentity | undefined;
  if (existing) {
    const same = (Object.keys(attempted) as (keyof CoreIdentity)[]).every((k) => existing[k] === attempted[k]);
    if (!same) throw new IdentityMismatchError(existing, attempted);
    return existing;
  }
  rt.identity = attempted;
  return attempted;
}

/** The page identity, or undefined before the shell calls initializeCore (e.g. a remote run standalone). */
export function getIdentity(): CoreIdentity | undefined {
  return getRuntime().identity as CoreIdentity | undefined;
}

/** Whether initializeCore has run on this page. */
export function isInitialized(): boolean {
  return getRuntime().identity !== undefined;
}
