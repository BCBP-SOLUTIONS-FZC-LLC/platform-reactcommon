// Redirect-target validation, shared by /nav (public isSafeRedirect) and /auth (returnUrl checks),
// which may not import /nav.

// Control characters, any whitespace and backslashes are refused before parsing: the URL parser
// silently drops tabs and newlines and treats '\' as '/', which turns '/\t/evil' or '/\evil'
// into the protocol-relative '//evil'.
const UNSAFE = /[\p{Cc}\s\\\u2028\u2029]/u;

/**
 * Whether `url` is a safe redirect target: http(s) on the same origin as `base` (default: the
 * page), with no protocol-relative, backslash, whitespace or control-character tricks. Use it on
 * every returnUrl before following it.
 */
export function isSafeRedirect(url: string, base?: string): boolean {
  if (typeof url !== 'string' || url === '' || UNSAFE.test(url)) return false;
  const baseHref = base ?? globalThis.location?.href;
  if (typeof baseHref !== 'string') return false;
  let target: URL;
  let origin: URL;
  try {
    origin = new URL(baseHref);
    target = new URL(url, origin);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  if (target.username !== '' || target.password !== '') return false;
  return target.origin === origin.origin;
}
