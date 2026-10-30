// The response headers of design doc §C3 (every behavior except /api/*, which the gateway owns), from
// one source. response-headers-policy.json must match (test/csp.test.ts).

/** Trusted Types policies the page creates: /security, @platform/webpack-preset, DOMPurify. */
export const TRUSTED_TYPES_POLICIES = ['platform-sdk', 'platform-webpack', 'dompurify'];

/** The Content-Security-Policy value. `idpOrigin` is the Keycloak origin the token fetches go to (§D4). */
export function buildCsp({ idpOrigin = 'https://auth.bcbpsolutions.com' } = {}) {
  const origin = new URL(idpOrigin).origin;
  if (origin !== idpOrigin || !idpOrigin.startsWith('https://')) throw new TypeError(`idpOrigin must be an https origin, got ${idpOrigin}`);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${origin}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICIES.join(' ')}`,
    'report-to csp',
  ].join('; ');
}

/** Every header of the policy, CSP included. */
export function securityHeaders(o) {
  return {
    'Content-Security-Policy': buildCsp(o),
    'Reporting-Endpoints': 'csp="/csp-report"',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}
