// The runtime config schema (design doc §C1 /config): one /config/runtime.json per environment,
// validated strictly (unknown keys rejected at every level) so a typo fails the bootstrap instead
// of being silently ignored. Defaults exist only where the design doc names one.
import { z } from 'zod';

// Zod's fast path probes `new Function('')` on first parse. Under the CSP's script-src 'self' (design
// doc §C3) the probe throws (caught) but still fires a CSP violation and a /csp-report on every page
// load. Jitless validation needs no eval. It must be set before any schema below is built.
z.config({ jitless: true });

/** The page's runtime configuration, loaded once by the shell. */
export interface RuntimeConfig {
  readonly api: {
    /** Same-origin path the API is served under, e.g. '/api'. */
    readonly baseUrl: string;
    /** Client deadline per call; default 35000 (above gincommon's 30 s server timeout). */
    readonly timeoutMs: number;
    /** Exact origins, besides the page's own, that receive trace propagation headers; default []. */
    readonly propagationAllowlist: readonly string[];
  };
  readonly telemetry: {
    /**
     * Off switch for the page's telemetry; default true. When false, tracing, logging and metrics
     * send nothing to the collector (their initialize calls are no-ops; dev console logging stays).
     */
    readonly enabled: boolean;
    /** Same-origin path of the OTLP/HTTP collector; default '/otel'. */
    readonly otlpBaseUrl: string;
    /** Trace sampling ratio in [0, 1]; default 0.1. */
    readonly sampleRatio: number;
    /** Minimum level sent; default 'info'. */
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
    /** Send the RUM session id as x-session-id; default true (opt-out). */
    readonly sendSessionHeader: boolean;
  };
  readonly auth: {
    /** Keycloak origin; default 'https://auth.bcbpsolutions.com' (IAM HLD §8.2.4). The issuer is `${idpOrigin}/realms/${realm}`. */
    readonly idpOrigin: string;
    /** The shared trial realm; default 'trial'. */
    readonly trialRealm: string;
    /** A resolved paid realm must equal `${paidRealmPrefix}${slug}`; default 'tenant-'. */
    readonly paidRealmPrefix: string;
    /** Workspace URLs are `${workspacePathPrefix}<slug>/…`; default '/t/'. */
    readonly workspacePathPrefix: string;
    /** OIDC client; default 'tender-web'. */
    readonly clientId: string;
    /** OIDC scopes; must include 'openid'; default ['openid']. */
    readonly scopes: readonly string[];
    /** SDK idle timeout; at most 8 h, the refresh token's idle lifetime (HLD §11.3). */
    readonly idleTimeoutMs: number;
    /** Same-origin path Keycloak redirects back to. */
    readonly redirectPath: string;
  };
  /** Platform flags (kill switches, rollout). Names are opaque; default {}. */
  readonly flags: Readonly<Record<string, boolean | string | number>>;
  readonly remotes: {
    /** Remote names that must not load; default []. */
    readonly killSwitch: readonly string[];
    readonly loadTimeoutMs: number;
    readonly retries: number;
    /** Exact origins, besides the page's own, remote entries may come from; default []. */
    readonly allowedOrigins: readonly string[];
  };
  readonly i18n: {
    /** A canonical BCP 47 tag, e.g. 'en' or 'ar'. */
    readonly defaultLocale: string;
    /** Canonical BCP 47 tags; must include defaultLocale. */
    readonly supportedLocales: readonly string[];
  };
  readonly appUpdate: {
    /** How often /version.json is polled; at least 10 s. */
    readonly pollIntervalMs: number;
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An http origin on a local host: accepted only on a local or dev page (checked by setRuntimeConfig and loadRuntimeConfig). */
export function isLocalHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
const HOUR_MS = 3_600_000;

/**
 * An exact origin (scheme://host[:port], nothing else): https, or http on a local host only. The
 * schema cannot know the page's environment: http on a local host is refused outside local and dev
 * when the config is loaded or set (runtime-config.ts).
 */
const exactOrigin = z.string().superRefine((value, ctx) => {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const ok =
    url !== undefined &&
    url.origin === value &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)));
  if (!ok) ctx.addIssue({ code: 'custom', message: `must be an exact https origin (http only for localhost), got ${JSON.stringify(value)}` });
});

/** A same-origin absolute path: no scheme, no '//', no '\', no query or fragment, no dot segments. */
const sameOriginPath = z.string().superRefine((value, ctx) => {
  const ok =
    /^\/(?!\/)[^\s?#\\]*$/.test(value) &&
    !value.split('/').some((segment) => segment === '.' || segment === '..') &&
    !/[\p{Cc}]/u.test(value);
  if (!ok) ctx.addIssue({ code: 'custom', message: `must be a same-origin path such as '/api', got ${JSON.stringify(value)}` });
});

const slug = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lower-case kebab slug');
const mfeName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'must match ^[a-z][a-z0-9_-]{0,62}$ (the mfe label)');
const scopeToken = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'must be an OAuth scope token (RFC 6749 §3.3)');
const intMs = (min: number, max: number) => z.number().int().min(min).max(max);

const canonicalLocale = z.string().superRefine((value, ctx) => {
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(value)[0];
  } catch {
    canonical = undefined;
  }
  if (canonical !== value) {
    ctx.addIssue({
      code: 'custom',
      message: canonical ? `must be the canonical tag ${JSON.stringify(canonical)}` : `${JSON.stringify(value)} is not a BCP 47 language tag`,
    });
  }
});

const schema = z
  .object({
    api: z
      .object({
        baseUrl: sameOriginPath,
        timeoutMs: intMs(1_000, 300_000).default(35_000),
        propagationAllowlist: z.array(exactOrigin).default([]),
      })
      .strict(),
    telemetry: z
      .object({
        enabled: z.boolean().default(true),
        otlpBaseUrl: sameOriginPath.default('/otel'),
        sampleRatio: z.number().min(0).max(1).default(0.1),
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        sendSessionHeader: z.boolean().default(true),
      })
      .strict(),
    auth: z
      .object({
        idpOrigin: exactOrigin.default('https://auth.bcbpsolutions.com'),
        trialRealm: slug.default('trial'),
        paidRealmPrefix: z.string().regex(/^[a-z][a-z0-9-]*-$/, "must be a lower-case prefix ending in '-'").default('tenant-'),
        workspacePathPrefix: sameOriginPath
          .refine((v) => v.length > 1 && v.endsWith('/'), "must start and end with '/', e.g. '/t/'")
          .default('/t/'),
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/, 'must be an OIDC client id').default('tender-web'),
        scopes: z
          .array(scopeToken)
          .refine((s) => s.includes('openid'), "must include 'openid'")
          .default(['openid']),
        idleTimeoutMs: intMs(60_000, 8 * HOUR_MS),
        redirectPath: sameOriginPath,
      })
      .strict()
      .refine((a) => !a.trialRealm.startsWith(a.paidRealmPrefix), {
        message: 'trialRealm must not start with paidRealmPrefix, or a trial realm would look like a paid one',
        path: ['trialRealm'],
      }),
    flags: z.record(z.string().min(1), z.union([z.boolean(), z.string(), z.number().refine(Number.isFinite, 'must be finite')])).default({}),
    remotes: z
      .object({
        killSwitch: z.array(mfeName).default([]),
        loadTimeoutMs: intMs(1_000, 120_000),
        retries: z.number().int().min(0).max(5),
        allowedOrigins: z.array(exactOrigin).default([]),
      })
      .strict(),
    i18n: z
      .object({
        defaultLocale: canonicalLocale,
        supportedLocales: z.array(canonicalLocale).min(1),
      })
      .strict()
      .refine((i) => i.supportedLocales.includes(i.defaultLocale), {
        message: 'must include defaultLocale',
        path: ['supportedLocales'],
      }),
    appUpdate: z.object({ pollIntervalMs: intMs(10_000, 24 * HOUR_MS) }).strict(),
  })
  .strict();

/** The schema of /config/runtime.json: strict (unknown keys rejected at every level), with defaults applied. */
export const RuntimeConfigSchema: z.ZodType<RuntimeConfig> = schema;
