// The page locale as /i18n keeps it on the PlatformRuntime, readable without importing /i18n.
import { getRuntime } from './runtime.ts';

// Scripts written right to left. 'ar*' is the platform's case (design doc §C1); the others keep
// dir correct for any other RTL locale a deployment adds.
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'ckb', 'yi', 'sd', 'ug']);

/** 'rtl' for right-to-left scripts. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  try {
    return RTL_LANGUAGES.has(new Intl.Locale(locale).language) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

/** The locale /i18n keeps on the runtime, else the runtime config's default, else 'en'; with its direction. */
export function runtimeLocale(): { locale: string; dir: 'ltr' | 'rtl' } {
  const rt = getRuntime();
  const locale =
    (rt.i18n as { locale?: string } | undefined)?.locale ??
    (rt.config as { i18n?: { defaultLocale?: string } } | undefined)?.i18n?.defaultLocale ??
    'en';
  return { locale, dir: directionOf(locale) };
}
