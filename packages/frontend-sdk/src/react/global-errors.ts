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

/** Shell only: window error, unhandledrejection and securitypolicyviolation handlers. Returns a remover. */
export function installGlobalErrorHandlers(): () => void {
  const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
  if (typeof target.addEventListener !== 'function') return () => {};
  const log = getLogger();

  const onError = (ev: Event) => {
    const e = ev as ErrorEvent;
    const error: unknown = e.error ?? e.message;
    recordWebError('unhandled_error', 'shell', error);
    if (reloadOnceForChunkError(error)) return;
    log.error('uncaught error', { error, ...(e.filename ? { source: blockedOrigin(e.filename) } : {}) });
  };
  const onRejection = (ev: Event) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    recordWebError('unhandled_rejection', 'shell', reason);
    if (reloadOnceForChunkError(reason)) return;
    log.error('unhandled promise rejection', { error: reason });
  };
  const onViolation = (ev: Event) => {
    const v = ev as SecurityPolicyViolationEvent;
    log.warn('content security policy violation', {
      essential: true,
      violated_directive: String(v.violatedDirective ?? v.effectiveDirective ?? '').slice(0, 64),
      blocked_uri: blockedOrigin(String(v.blockedURI ?? '')),
      disposition: v.disposition === 'report' ? 'report' : 'enforce',
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
