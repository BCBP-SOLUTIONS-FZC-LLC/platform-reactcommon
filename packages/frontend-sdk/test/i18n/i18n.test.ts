// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatMoney, formatNumber, initializeI18n, problemMessage, registerNamespace, setLocale, t } from '../../src/i18n/index.ts';
import { currentLocale, subscribeI18n } from '../../src/i18n/i18n.ts';
import { directionOf } from '../../src/internal/locale.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { parseProblemResponse } from '../../src/problem/index.ts';

const catalogs: Record<string, Record<string, Record<string, string>>> = {
  tenders: {
    en: { title: 'Tenders', bids: '{n, plural, one {# bid} other {# bids}}', only_en: 'English only' },
    ar: { title: 'المناقصات', bids: '{n, plural, zero {لا عروض} one {عرض واحد} two {عرضان} few {# عروض} many {# عرضًا} other {# عرض}}' },
  },
  platform: {
    en: {
      'problem.platform/forbidden': 'You are not allowed to do this.',
      'problem.platform/forbidden.DENY_MFA_STALE': 'Sign in again with your second factor (HTTP {status}).',
    },
    ar: { 'problem.platform/forbidden': 'غير مسموح لك بهذا.' },
  },
};
const loader = (ns: string) => vi.fn(async (locale: string) => catalogs[ns]?.[locale] ?? {});
const problem = async (body: Record<string, unknown>, status: number) =>
  parseProblemResponse(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json' } }));

beforeEach(() => {
  resetRuntimeForTests();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('initializeI18n', () => {
  it('uses detect(), then sets <html lang dir>', async () => {
    expect(await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'ar-AE' })).toBe('ar');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(currentLocale()).toEqual({ locale: 'ar', dir: 'rtl' });
  });

  it("falls back to the browser's languages, then the default", async () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'en-GB'] });
    expect(await initializeI18n({ defaultLocale: 'ar', supported: ['ar', 'en'] })).toBe('en');
    resetRuntimeForTests();
    vi.stubGlobal('navigator', { languages: ['de'] });
    expect(await initializeI18n({ defaultLocale: 'ar', supported: ['ar', 'en'] })).toBe('ar');
    resetRuntimeForTests();
    expect(await initializeI18n({ defaultLocale: 'en', supported: ['en'], detect: () => { throw new Error('x'); } })).toBe('en');
    expect(await initializeI18n({ defaultLocale: 'en', supported: ['en'], detect: () => 'not a tag!' })).toBe('en');
  });

  it('validates its locales', async () => {
    await expect(initializeI18n({ defaultLocale: 'en', supported: ['ar'] })).rejects.toThrow(RangeError);
    await expect(initializeI18n({ defaultLocale: 'x-not-valid!', supported: ['en'] })).rejects.toThrow(RangeError);
  });
});

describe('setLocale and directions', () => {
  it('negotiates within supported locales and rejects others', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    await setLocale('ar-SA');
    expect(currentLocale().locale).toBe('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    await setLocale('en-US');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    await expect(setLocale('fr')).rejects.toThrow(RangeError);
  });

  it('marks right-to-left languages rtl', () => {
    expect(['ar', 'ar-AE', 'he', 'fa', 'ur'].map(directionOf)).toEqual(['rtl', 'rtl', 'rtl', 'rtl', 'rtl']);
    expect(['en', 'fr', 'zh-Hans', 'garbage!'].map(directionOf)).toEqual(['ltr', 'ltr', 'ltr', 'ltr']);
  });

  it('lets the last of two overlapping setLocale calls win', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    let release!: () => void;
    registerNamespace('slow', (locale) => (locale === 'ar' ? new Promise((r) => (release = () => r({})) as never) : Promise.resolve({})));
    const first = setLocale('ar');
    await setLocale('en');
    release();
    await first;
    expect(currentLocale().locale).toBe('en');
  });

  it('notifies subscribers on locale changes and catalog loads', async () => {
    const l = vi.fn();
    const off = subscribeI18n(l);
    await initializeI18n({ defaultLocale: 'en', supported: ['en'], detect: () => 'en' });
    expect(l).toHaveBeenCalledTimes(1);
    registerNamespace('tenders', loader('tenders'));
    await vi.waitFor(() => expect(l).toHaveBeenCalledTimes(2));
    off();
    await setLocale('en');
    expect(l).toHaveBeenCalledTimes(2);
  });
});

describe('namespaces and t()', () => {
  it('loads a namespace for the current and default locales, falling back to the default, then the key', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'ar' });
    const l = loader('tenders');
    registerNamespace('tenders', l);
    await vi.waitFor(() => expect(t('tenders', 'title')).toBe('المناقصات'));
    expect(l.mock.calls.map((c) => c[0]).sort()).toEqual(['ar', 'en']);
    expect(t('tenders', 'only_en')).toBe('English only');
    expect(t('tenders', 'missing.key')).toBe('missing.key');
    expect(t('unknown-ns', 'x')).toBe('x');
  });

  it('formats plurals in the current locale', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    registerNamespace('tenders', loader('tenders'));
    await vi.waitFor(() => expect(t('tenders', 'bids', { n: 1 })).toBe('1 bid'));
    await setLocale('ar');
    expect(t('tenders', 'bids', { n: 2 })).toBe('عرضان');
    expect(t('tenders', 'bids', { n: 0 })).toBe('لا عروض');
  });

  it('loads namespaces registered before init on the first setLocale, once each', async () => {
    const l = loader('tenders');
    registerNamespace('tenders', l);
    registerNamespace('tenders', loader('tenders')); // ignored: already registered
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    await setLocale('ar');
    await setLocale('en');
    expect(l.mock.calls.map((c) => c[0]).sort()).toEqual(['ar', 'en']);
  });

  it('survives a failing or malformed loader and ignores non-string messages', async () => {
    registerNamespace('broken', async () => { throw new Error('404'); });
    registerNamespace('weird', async () => ['x'] as never);
    registerNamespace('mixed', async () => ({ ok: 'yes', bad: 1, nested: { x: 'y' } }) as never);
    await initializeI18n({ defaultLocale: 'en', supported: ['en'], detect: () => 'en' });
    expect(t('broken', 'k')).toBe('k');
    expect(t('mixed', 'ok')).toBe('yes');
    expect(t('mixed', 'bad')).toBe('bad');
    expect(console.warn).toHaveBeenCalled();
  });

  it('validates namespaces and loaders', () => {
    expect(() => registerNamespace('Tenders', async () => ({}))).toThrow(TypeError);
    expect(() => registerNamespace('tenders', 'x' as never)).toThrow(TypeError);
  });

  it('shows a malformed message as is', async () => {
    registerNamespace('bad', async () => ({ msg: 'Hello {name' }));
    await initializeI18n({ defaultLocale: 'en', supported: ['en'], detect: () => 'en' });
    expect(t('bad', 'msg', { name: 'x' })).toBe('Hello {name');
  });
});

describe('Intl formatting', () => {
  it('formats money (AED by default), numbers and dates for the current locale', async () => {
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    expect(formatMoney(1234.5)).toMatch(/^AED\s1,234\.50$/u); // Intl separates with a no-break space
    expect(formatMoney(10, 'USD')).toBe('$10.00');
    expect(() => formatMoney(1, 'not-a-code')).toThrow(RangeError);
    expect(formatNumber(0.256, { style: 'percent' })).toBe('26%');
    expect(formatDate(Date.UTC(2026, 9, 30), { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Oct 30, 2026');
    expect(formatDate(new Date('nope'))).toBe('');
    await setLocale('ar');
    expect(formatMoney(5)).toContain('د.إ.');
  });

  it("uses the config's default locale before initializeI18n", () => {
    expect(formatNumber(1000)).toBe('1,000');
  });
});

describe('problemMessage', () => {
  beforeEach(async () => {
    registerNamespace('platform', loader('platform'));
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
  });

  it('prefers problem.<typeId>.<errorCode>, then problem.<typeId>, then the title', async () => {
    const forbidden = { type: 'https://errors.company.com/platform/forbidden', title: 'Forbidden', status: 403 };
    expect(problemMessage(await problem({ ...forbidden, errorCode: 'DENY_MFA_STALE' }, 403))).toBe('Sign in again with your second factor (HTTP 403).');
    expect(problemMessage(await problem({ ...forbidden, errorCode: 'DENY_ROLE_INSUFFICIENT' }, 403))).toBe('You are not allowed to do this.');
    expect(problemMessage(await problem({ type: 'https://errors.company.com/platform/conflict', title: 'Conflict', status: 409 }, 409))).toBe('Conflict');
    expect(problemMessage(await problem({ type: 'about:blank', title: 'Gone', status: 410 }, 410))).toBe('Gone');
  });

  it('never shows the server detail', async () => {
    const p = await problem({ type: 'https://errors.company.com/platform/conflict', title: 'Conflict', status: 409, detail: 'English server text' }, 409);
    expect(problemMessage(p)).toBe('Conflict');
  });

  it('follows the locale', async () => {
    await setLocale('ar');
    const p = await problem({ type: 'https://errors.company.com/platform/forbidden', title: 'Forbidden', status: 403, errorCode: 'DENY_MFA_STALE' }, 403);
    expect(problemMessage(p)).toBe('غير مسموح لك بهذا.'); // no Arabic deny-code message: the type's
  });
});
