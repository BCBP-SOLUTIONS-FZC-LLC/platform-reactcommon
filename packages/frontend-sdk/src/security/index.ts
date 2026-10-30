/**
 * Browser security helpers for the strict CSP (design doc §C3): HTML sanitisation with DOMPurify,
 * the 'platform-sdk' Trusted Types policy, and exact-origin checks.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/security`.
 *
 * @packageDocumentation
 */
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import type { TrustedHTML, TrustedTypePolicyFactory } from 'trusted-types/lib';
import { getRuntime } from '../internal/runtime.ts';

const POLICY_NAME = 'platform-sdk';

/** The browser's Trusted Types factory, where there is one. */
const trustedTypesFactory = (): TrustedTypePolicyFactory | undefined =>
  (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;

// Never rendered from untrusted HTML: active content, forms, embedded documents, and anything the
// strict CSP would block anyway (inline styles), so a sanitised fragment cannot trigger reports.
const FORBID_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'template', 'base', 'link', 'meta'];
const FORBID_ATTR = ['style', 'srcset', 'action', 'formaction', 'target'];
const SAFE_LINK = /^(?:https?:|mailto:|\/(?!\/))/i;

let purifier: DOMPurify | undefined;

function getPurifier(): DOMPurify | undefined {
  if (purifier) return purifier;
  if (typeof globalThis.window === 'undefined') return undefined;
  const p = createDOMPurify(globalThis.window);
  if (!p.isSupported) return undefined;
  // Links that stay: no opener, no referrer.
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) node.setAttribute('rel', 'noopener noreferrer');
  });
  purifier = p;
  return p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function config(allowLinks: boolean, trusted: boolean): Config {
  return {
    USE_PROFILES: { html: true },
    FORBID_TAGS: allowLinks ? FORBID_TAGS : [...FORBID_TAGS, 'a'],
    FORBID_ATTR,
    ALLOWED_URI_REGEXP: SAFE_LINK,
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: trusted,
  };
}

/**
 * Sanitises untrusted HTML (rich text from an API, translated markup) for innerHTML. Scripts,
 * event handlers, forms, embedded content and inline styles are removed; links are removed
 * (their text kept) unless `allowLinks`, and then only http(s), mailto and same-origin paths
 * remain, with rel="noopener noreferrer". Returns TrustedHTML where Trusted Types exist (from
 * DOMPurify's own 'dompurify' policy), a string elsewhere; outside a DOM the input is escaped.
 */
export function sanitizeHtml(dirty: string, o?: { allowLinks?: boolean }): TrustedHTML | string {
  const text = typeof dirty === 'string' ? dirty : String(dirty ?? '');
  const p = getPurifier();
  if (!p) return escapeHtml(text);
  const trusted = typeof trustedTypesFactory()?.createPolicy === 'function';
  if (trusted) return p.sanitize(text, { ...config(o?.allowLinks === true, true), RETURN_TRUSTED_TYPE: true });
  return p.sanitize(text, config(o?.allowLinks === true, false));
}

/**
 * Whether `url` (absolute, or relative to the page) is http(s) on the page's own origin or on one
 * of the exact origins in `allowlist`. Anything unparsable is not allowed.
 */
export function isAllowedOrigin(url: string, allowlist: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url, globalThis.location?.href);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (globalThis.location !== undefined && u.origin === globalThis.location.origin) return true;
  return Array.isArray(allowlist) && allowlist.includes(u.origin);
}

/** Remote origins from the runtime config (remotes.allowedOrigins), read through the PlatformRuntime. */
function remoteOrigins(): readonly string[] {
  const cfg = getRuntime().config as { remotes?: { allowedOrigins?: readonly string[] } } | undefined;
  return cfg?.remotes?.allowedOrigins ?? [];
}

/**
 * Shell only, first thing in the bootstrap: creates the 'platform-sdk' Trusted Types policy the
 * CSP allows (`trusted-types platform-sdk platform-webpack dompurify`). Its HTML is sanitised as
 * sanitizeHtml does; its script URLs must be same-origin or a configured remote origin; it never
 * creates scripts from strings. Idempotent; a no-op where the browser has no Trusted Types.
 */
export function installTrustedTypesPolicy(): void {
  const rt = getRuntime();
  if (rt.trustedTypesPolicy) return;
  const factory = trustedTypesFactory();
  if (typeof factory?.createPolicy !== 'function') return;
  rt.trustedTypesPolicy = factory.createPolicy(POLICY_NAME, {
    createHTML: (s: string) => {
      const p = getPurifier();
      return p ? (p.sanitize(s, config(false, false)) as string) : escapeHtml(s);
    },
    createScriptURL: (url: string) => {
      if (!isAllowedOrigin(url, remoteOrigins())) throw new TypeError(`script URL ${JSON.stringify(url)} is not same-origin or an allowed remote origin`);
      return new URL(url, globalThis.location?.href).href;
    },
    createScript: () => {
      throw new TypeError('the platform-sdk policy never creates scripts from strings');
    },
  });
}
