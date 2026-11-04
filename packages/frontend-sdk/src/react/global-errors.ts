// Page-wide error capture (design doc §C1 /react): uncaught errors and unhandled rejections become
// error logs (a chunk-load failure reloads once instead), and CSP violations after bootstrap become
// redacted essential warn logs, so they reach Loki with trace and session correlation.
import { getLogger } from '../logging/index.ts';
import { reloadOnceForChunkError } from '../mfe/index.ts';
import { recordWebError } from './web-errors.ts';

/** The origin of a blocked URI, or the CSP keyword ('inline', 'eval', …); never a path or query. */
function blockedOrigin(uri: string): string {
  if (!uri) return '';
  try {
    const u = new URL(uri);
    return u.origin === 'null' ? u.protocol.replace(/:$/, '') : u.origin;
  } catch {
    return /^[a-z-]{1,32}$/.test(uri) ? uri : 'other';
  }
}

/** Logs per signature per window, and for the page; past them a line is counted, not sent. */
const PER_SIGNATURE = 10;
const PER_PAGE = 60;
const WINDOW_MS = 60_000;

/**
 * A throwing requestAnimationFrame loop or interval would otherwise send thousands of error logs a second,
 * pushing every useful line out of the queue. The next line of a signature carries `suppressed` (how many
 * were dropped since). The web-error metric still counts every one.
 */
function rateLimiter(now: () => number = Date.now): (signature: string) => { send: boolean; suppressed: number } {
  let windowStart = now();
  let pageCount = 0;
  const counts = new Map<string, number>();
  const dropped = new Map<string, number>();
  return (signature) => {
    if (now() - windowStart >= WINDOW_MS) {
      windowStart = now();
      pageCount = 0;
      counts.clear();
    }
    const n = (counts.get(signature) ?? 0) + 1;
    counts.set(signature, n);
    if (n > PER_SIGNATURE || pageCount >= PER_PAGE) {
      if (dropped.size < 1_000 || dropped.has(signature)) dropped.set(signature, (dropped.get(signature) ?? 0) + 1);
      return { send: false, suppressed: 0 };
    }
    pageCount++;
    const suppressed = dropped.get(signature) ?? 0;
    dropped.delete(signature);
    return { send: true, suppressed };
  };
}

/** What makes two errors the same for rate limiting: type, message and the first stack frame. */
function signatureOf(kind: string, error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const frame = typeof e?.stack === 'string' ? (e.stack.split('\n').find((l) => /^\s+at |@/.test(l)) ?? '') : '';
  const text = typeof error === 'string' ? error : String(e?.message ?? '');
  return `${kind}|${String(e?.name ?? typeof error)}|${text.slice(0, 200)}|${frame.trim().slice(0, 200)}`;
}

/** Shell only: window error, unhandledrejection and securitypolicyviolation handlers. Returns a remover. */
export function installGlobalErrorHandlers(): () => void {
  const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
  if (typeof target.addEventListener !== 'function') return () => {};
  const log = getLogger();
  const allow = rateLimiter();
  const extra = (suppressed: number) => (suppressed > 0 ? { suppressed } : {});

  const onError = (ev: Event) => {
    const e = ev as ErrorEvent;
    const error: unknown = e.error ?? e.message;
    recordWebError('unhandled_error', 'shell', error);
    if (reloadOnceForChunkError(error)) return;
    const { send, suppressed } = allow(signatureOf('error', error));
    if (send) log.error('uncaught error', { error, ...(e.filename ? { source: blockedOrigin(e.filename) } : {}), ...extra(suppressed) });
  };
  const onRejection = (ev: Event) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    recordWebError('unhandled_rejection', 'shell', reason);
    if (reloadOnceForChunkError(reason)) return;
    const { send, suppressed } = allow(signatureOf('rejection', reason));
    if (send) log.error('unhandled promise rejection', { error: reason, ...extra(suppressed) });
  };
  const onViolation = (ev: Event) => {
    const v = ev as SecurityPolicyViolationEvent;
    const directive = String(v.violatedDirective ?? v.effectiveDirective ?? '').slice(0, 64);
    const blocked = blockedOrigin(String(v.blockedURI ?? ''));
    const { send, suppressed } = allow(`csp|${directive}|${blocked}`);
    if (!send) return;
    log.warn('content security policy violation', {
      essential: true,
      violated_directive: directive,
      blocked_uri: blocked,
      disposition: v.disposition === 'report' ? 'report' : 'enforce',
      ...extra(suppressed),
    });
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('securitypolicyviolation', onViolation);
  return () => {
    target.removeEventListener?.('error', onError);
    target.removeEventListener?.('unhandledrejection', onRejection);
    target.removeEventListener?.('securitypolicyviolation', onViolation);
  };
}
