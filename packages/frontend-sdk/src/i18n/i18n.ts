// Localisation (design doc §C1 /i18n): locale negotiation, <html lang dir>, per-remote message
// namespaces loaded on demand, ICU-lite messages, Intl formatting and problem messages.
import { getIdentity } from '../core/index.ts';
import { tryGetConfig } from '../config/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import type { ProblemError } from '../problem/index.ts';
import { formatMessage, type FormatContext, type MessageVars } from './messages.ts';

type Catalog = Readonly<Record<string, string>>;
type Loader = (locale: string) => Promise<Record<string, string>>;

interface I18nState {
  locale: string;
  defaultLocale: string;
  supported: readonly string[];
  loaders: Map<string, Loader>;
  /** namespace → locale → catalog */
  catalogs: Map<string, Map<string, Catalog>>;
  /** `${namespace}|${locale}` → the load in flight, so concurrent callers share it */
  loading: Map<string, Promise<void>>;
  listeners: Set<() => void>;
  generation: number;
}

const NAMESPACE = /^[a-z][a-z0-9_-]{0,62}$/;
/** Namespace holding the shell's shared messages, including problem.* keys. */
export const PLATFORM_NAMESPACE = 'platform';
// Scripts written right to left. 'ar*' is the platform's case (design doc §C1); the others keep
// dir correct for any other RTL locale a deployment adds.
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'ckb', 'yi', 'sd', 'ug']);

function warn(message: string): void {
  const env = getIdentity()?.environment;
  if (env === undefined || env === 'local' || env === 'dev') console.warn(`@platform/frontend-sdk/i18n: ${message}`);
}

function state(): I18nState {
  const rt = getRuntime();
  if (!rt.i18n) {
    const def = tryGetConfig()?.i18n.defaultLocale ?? 'en';
    rt.i18n = {
      locale: def,
      defaultLocale: def,
      supported: [def],
      loaders: new Map(),
      catalogs: new Map(),
      loading: new Map(),
      listeners: new Set(),
      generation: 0,
    } satisfies I18nState;
  }
  return rt.i18n as I18nState;
}

function canonical(tag: string): string {
  const [c] = Intl.getCanonicalLocales(tag);
  if (!c) throw new RangeError(`${JSON.stringify(tag)} is not a BCP 47 language tag`);
  return c;
}

/** The best supported locale for a requested one: exact, then same language, else undefined. */
function negotiate(requested: string | undefined, supported: readonly string[]): string | undefined {
  if (!requested) return undefined;
  let tag: string;
  try {
    tag = canonical(requested);
  } catch {
    return undefined;
  }
  if (supported.includes(tag)) return tag;
  const language = new Intl.Locale(tag).language;
  return supported.find((s) => new Intl.Locale(s).language === language);
}

/** 'rtl' for right-to-left scripts. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  try {
    return RTL_LANGUAGES.has(new Intl.Locale(locale).language) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

/** Internal (for /react): called after every locale change or catalog load. */
export function subscribeI18n(l: () => void): () => void {
  const s = state();
  s.listeners.add(l);
  return () => s.listeners.delete(l);
}

/** Internal (for /react): the current locale and direction. */
export function currentLocale(): { locale: string; dir: 'ltr' | 'rtl' } {
  const locale = state().locale;
  return { locale, dir: directionOf(locale) };
}

function notify(): void {
  for (const l of [...state().listeners]) {
    try {
      l();
    } catch {
      // a listener's failure never stops the others
    }
  }
}

async function loadCatalog(ns: string, locale: string): Promise<void> {
  const s = state();
  const loader = s.loaders.get(ns);
  if (!loader) return;
  let raw: unknown;
  try {
    raw = await loader(locale);
  } catch (e) {
    warn(`namespace "${ns}" failed to load for ${locale}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn(`namespace "${ns}" for ${locale} is not an object of messages`);
    return;
  }
  const catalog: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') catalog[k] = v;
  const byLocale = s.catalogs.get(ns) ?? new Map<string, Catalog>();
  byLocale.set(locale, Object.freeze(catalog));
  s.catalogs.set(ns, byLocale);
}

/** Loads `ns` for the current locale and the default locale (the fallback), unless already loaded. */
async function ensureLoaded(namespaces: readonly string[], locale: string): Promise<void> {
  const s = state();
  const locales = locale === s.defaultLocale ? [locale] : [locale, s.defaultLocale];
  await Promise.all(
    namespaces.flatMap((ns) =>
      locales
        .filter((l) => !s.catalogs.get(ns)?.has(l))
        .map((l) => {
          const key = `${ns}|${l}`;
          let p = s.loading.get(key);
          if (!p) {
            p = loadCatalog(ns, l).finally(() => s.loading.delete(key));
            s.loading.set(key, p);
          }
          return p;
        }),
    ),
  );
}

/**
 * Shell only: negotiates the locale (from `detect`, else the browser's languages, else the
 * default), sets it with setLocale and returns it. `supported` must include `defaultLocale`.
 */
export async function initializeI18n(o: {
  defaultLocale: string;
  supported: readonly string[];
  detect?: () => string | undefined;
}): Promise<string> {
  const defaultLocale = canonical(o.defaultLocale);
  const supported = [...new Set(o.supported.map(canonical))];
  if (!supported.includes(defaultLocale)) throw new RangeError(`supported locales must include the default ${defaultLocale}`);
  const s = state();
  s.defaultLocale = defaultLocale;
  s.supported = Object.freeze(supported);
  let detected: string | undefined;
  try {
    detected = o.detect?.();
  } catch {
    detected = undefined;
  }
  const candidates = detected !== undefined ? [detected] : [...(globalThis.navigator?.languages ?? [])];
  const locale = candidates.map((c) => negotiate(c, supported)).find((c) => c !== undefined) ?? defaultLocale;
  await setLocale(locale);
  return locale;
}

/**
 * Switches the locale: sets <html lang dir> ('ar*' and other RTL languages → rtl), loads every
 * registered namespace for it, then notifies subscribers. An unsupported locale is negotiated to
 * a supported one of the same language, else rejected with a RangeError.
 */
export async function setLocale(locale: string): Promise<void> {
  const s = state();
  const chosen = negotiate(locale, s.supported);
  if (!chosen) throw new RangeError(`locale ${JSON.stringify(locale)} is not supported (${s.supported.join(', ')})`);
  const generation = ++s.generation;
  await ensureLoaded([...s.loaders.keys()], chosen);
  if (generation !== s.generation) return; // a later setLocale won
  s.locale = chosen;
  const root = globalThis.document?.documentElement;
  if (root) {
    root.setAttribute('lang', chosen);
    root.setAttribute('dir', directionOf(chosen));
  }
  notify();
}

/**
 * Registers a remote's (or the shell's) message loader. Called once per namespace; the
 * namespace is loaded for the current locale right away, and on every later setLocale.
 */
export function registerNamespace(mfe: string, loader: Loader): void {
  if (typeof mfe !== 'string' || !NAMESPACE.test(mfe)) throw new TypeError(`namespace must match ${NAMESPACE.source}, got ${JSON.stringify(mfe)}`);
  if (typeof loader !== 'function') throw new TypeError('registerNamespace needs a loader function');
  const s = state();
  if (s.loaders.has(mfe)) return;
  s.loaders.set(mfe, loader);
  void ensureLoaded([mfe], s.locale).then(notify);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function numberFormat(locale: string, o?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(o ?? {})}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, o);
    numberFormats.set(key, f);
  }
  return f;
}

function context(locale: string): FormatContext {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const r = rules;
  return { locale, number: (n) => numberFormat(locale).format(n), plural: (n) => r.select(n) };
}

function lookupIn(ns: string, key: string, locale: string): string | undefined {
  const catalog = state().catalogs.get(ns)?.get(locale);
  return catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

function lookup(ns: string, key: string): string | undefined {
  const s = state();
  return lookupIn(ns, key, s.locale) ?? lookupIn(ns, key, s.defaultLocale);
}

/**
 * The message `key` of namespace `ns` in the current locale (falling back to the default
 * locale, then to the key itself), formatted with `vars`. Returns plain text: render it as text,
 * never as HTML.
 */
export function t(ns: string, key: string, vars?: Record<string, string | number>): string {
  const message = lookup(ns, key);
  if (message === undefined) return key;
  return formatMessage(message, vars as MessageVars | undefined, context(state().locale), () =>
    warn(`message ${ns}:${key} is not valid ICU-lite; shown as is`),
  );
}

/** `v` as money in the current locale; default currency AED. An invalid currency code throws a RangeError. */
export function formatMoney(v: number, currency = 'AED'): string {
  return numberFormat(state().locale, { style: 'currency', currency }).format(v);
}

/** A date or epoch milliseconds in the current locale; an invalid date gives ''. */
export function formatDate(d: Date | number, o?: Intl.DateTimeFormatOptions): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const locale = state().locale;
  const key = `${locale}|${JSON.stringify(o ?? {})}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, o);
    dateFormats.set(key, f);
  }
  return f.format(date);
}

/** `n` in the current locale. */
export function formatNumber(n: number, o?: Intl.NumberFormatOptions): string {
  return numberFormat(state().locale, o).format(n);
}

/**
 * A message for a problem, from the shell's 'platform' namespace: `problem.<typeId>.<errorCode>`
 * (e.g. a gateway deny code), then `problem.<typeId>`, then the problem's title. Messages may use
 * {status} and {errorCode}. The server's detail is never shown here: it is not translated.
 */
export function problemMessage(p: ProblemError): string {
  const vars = { status: p.status, ...(p.errorCode ? { errorCode: p.errorCode } : {}) };
  const keys = [
    ...(p.typeId && p.errorCode ? [`problem.${p.typeId}.${p.errorCode}`] : []),
    ...(p.typeId ? [`problem.${p.typeId}`] : []),
  ];
  // Every key in the current locale first, then in the default one: a general message in the
  // user's language beats a specific one in another.
  const s = state();
  const ctx = context(s.locale);
  for (const locale of s.locale === s.defaultLocale ? [s.locale] : [s.locale, s.defaultLocale]) {
    for (const key of keys) {
      const message = lookupIn(PLATFORM_NAMESPACE, key, locale);
      if (message !== undefined) return formatMessage(message, vars, ctx, () => warn(`message ${PLATFORM_NAMESPACE}:${key} is not valid ICU-lite`));
    }
  }
  return p.title;
}
