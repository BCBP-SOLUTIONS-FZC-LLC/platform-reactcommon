// /csp-report (design doc §C3): a Lambda function URL behind CloudFront (POST only, WAF rate rule,
// 64 KB). Browsers post application/reports+json (Reporting API, `report-to`) or
// application/csp-report (`report-uri`). The OTel Collector has no receiver for those, so this turns
// each violation into an OTLP log (event.name=csp.violation): URLs lose their query string and
// fragment, every value goes through the platform's redaction, and nothing else from the report is kept.
//
// Origin authentication: NOT OAC. A function URL with AuthType AWS_IAM behind OAC needs the viewer to
// send x-amz-content-sha256 for a POST body, which a browser's report delivery never does, so every
// report would be a 403. The function URL is AuthType NONE instead, CloudFront adds a secret custom
// origin header (x-origin-verify) on this origin, and the handler rejects anything without it (403,
// constant-time compare). ORIGIN_VERIFY_SECRET holds the accepted values, comma-separated
// (current,previous) so the secret rotates without dropping reports; unset or empty fails closed.
// Environment: ORIGIN_VERIFY_SECRET, COLLECTOR_LOGS_URL (e.g. http://otel-collector:4318/v1/logs),
// SERVICE_NAMESPACE (the page's domain, 'portal' per §D1), DEPLOYMENT_ENVIRONMENT.
import { createHash, timingSafeEqual } from 'node:crypto';
import { sanitizeString } from '@platform/frontend-sdk/core';

const MAX_BODY = 64 * 1024;
const MAX_REPORTS = 20;
const TYPES = new Set(['application/reports+json', 'application/csp-report', 'application/json']);
const KEYWORDS = /^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink|data|blob|self)$/;

/** Origin and path, or a CSP keyword; never a query string, fragment or credentials. */
export function cleanUri(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  if (KEYWORDS.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1);
    return sanitizeString(`${u.origin}${u.pathname}`).slice(0, 512);
  } catch {
    return 'other';
  }
}

const str = (v, max = 128) => (typeof v === 'string' ? sanitizeString(v).slice(0, max) : '');

/** One violation from either report format, or undefined when it is not a CSP report. */
export function normalise(report) {
  if (!report || typeof report !== 'object') return undefined;
  // Reporting API: { type: 'csp-violation', body: { documentURL, blockedURL, effectiveDirective, … } }
  if (report.type === 'csp-violation' && report.body && typeof report.body === 'object') {
    const b = report.body;
    return {
      directive: str(b.effectiveDirective),
      blocked: cleanUri(b.blockedURL),
      document: cleanUri(b.documentURL),
      disposition: b.disposition === 'report' ? 'report' : 'enforce',
      source: cleanUri(b.sourceFile),
      line: Number.isInteger(b.lineNumber) ? b.lineNumber : undefined,
    };
  }
  // report-uri: { 'csp-report': { 'document-uri', 'blocked-uri', 'effective-directive', … } }
  const r = report['csp-report'];
  if (r && typeof r === 'object') {
    return {
      directive: str(r['effective-directive'] ?? r['violated-directive']),
      blocked: cleanUri(r['blocked-uri']),
      document: cleanUri(r['document-uri']),
      disposition: r.disposition === 'report' ? 'report' : 'enforce',
      source: cleanUri(r['source-file']),
      line: Number.isInteger(r['line-number']) ? r['line-number'] : undefined,
    };
  }
  return undefined;
}

/** OTLP/HTTP JSON logs request for the violations. */
export function toOtlp(violations, env = process.env, now = Date.now()) {
  const attr = (key, value) =>
    typeof value === 'number' ? { key, value: { intValue: String(value) } } : { key, value: { stringValue: String(value) } };
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr('service.name', 'csp-report'),
            attr('service.namespace', env.SERVICE_NAMESPACE ?? 'portal'),
            attr('deployment.environment.name', env.DEPLOYMENT_ENVIRONMENT ?? 'dev'),
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'csp-report' },
            logRecords: violations.map((v) => ({
              timeUnixNano: `${now}000000`,
              severityNumber: 13,
              severityText: 'WARN',
              body: { stringValue: 'content security policy violation' },
              attributes: [
                attr('event.name', 'csp.violation'),
                attr('csp.effective_directive', v.directive),
                attr('csp.blocked_uri', v.blocked),
                attr('csp.document_uri', v.document),
                attr('csp.disposition', v.disposition),
                ...(v.source ? [attr('csp.source_file', v.source)] : []),
                ...(v.line !== undefined ? [attr('csp.line_number', v.line)] : []),
              ],
            })),
          },
        ],
      },
    ],
  };
}

/** The custom origin header CloudFront adds on the /csp-report origin. */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

const digest = (v) => createHash('sha256').update(v, 'utf8').digest();

/**
 * Whether `presented` equals one of the comma-separated `secrets`. Compares SHA-256 digests with
 * timingSafeEqual (equal lengths, so neither the secret nor its length leaks through timing) and
 * checks every candidate. No configured secret → false (fail closed).
 */
export function originVerified(presented, secrets) {
  if (typeof presented !== 'string' || presented === '' || typeof secrets !== 'string') return false;
  const candidates = secrets.split(',').map((s) => s.trim()).filter(Boolean);
  const got = digest(presented);
  let ok = false;
  for (const c of candidates) ok = timingSafeEqual(got, digest(c)) || ok;
  return ok;
}

const reply = (statusCode) => ({ statusCode, headers: { 'cache-control': 'no-store' }, body: '' });

/** Lambda function URL handler (payload format 2.0). */
export async function handler(event, deps = { fetch: globalThis.fetch, env: process.env }) {
  // Before anything else, so a caller that bypassed CloudFront learns nothing about the endpoint.
  if (!originVerified(event?.headers?.[ORIGIN_VERIFY_HEADER], deps.env.ORIGIN_VERIFY_SECRET)) return reply(403);
  if (event?.requestContext?.http?.method !== 'POST') return reply(405);
  const type = String(event.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES.has(type)) return reply(415);
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : String(event.body ?? '');
  if (Buffer.byteLength(raw) > MAX_BODY) return reply(413);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reply(400);
  }
  const violations = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_REPORTS).map(normalise).filter(Boolean);
  if (violations.length === 0) return reply(204);
  const url = deps.env.COLLECTOR_LOGS_URL;
  if (!url) return reply(503);
  try {
    const res = await deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toOtlp(violations, deps.env)) });
    return reply(res.ok ? 204 : 502);
  } catch {
    return reply(502);
  }
}
