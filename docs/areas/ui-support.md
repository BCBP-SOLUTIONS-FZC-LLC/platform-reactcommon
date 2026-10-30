# UI support

`/i18n` · `/security`

What every screen needs and no screen should implement itself: text in the user's language and direction, locale-aware formatting, and HTML that's safe under the platform's Content Security Policy.

| Subpath | What it does | Main exports |
|---|---|---|
| `/i18n` | Message catalogs per remote (ICU-lite: placeholders, plurals, selects), locale negotiation, `<html lang dir>` (RTL for Arabic), dates, numbers, money; user-facing text for API errors | `initializeI18n`, `registerNamespace`, `setLocale`, `t`, `problemMessage`, `formatDate`, `formatNumber`, `formatMoney` |
| `/security` | HTML sanitizing (DOMPurify) and the `platform-sdk` Trusted Types policy the CSP requires | `installTrustedTypesPolicy`, `sanitizeHtml`, `isAllowedOrigin` |

## How it's used

The shell runs `installTrustedTypesPolicy()` first and `initializeI18n(...)` after sign-in. A remote registers its catalog and translates through the [developer surface](developer-surface.md):

```ts
registerNamespace('tenders', (locale) => import(`./i18n/${locale}.json`).then((m) => m.default));
const t = useT('tenders');
t('drafts.count', { n: 3 });
```

Untrusted HTML always goes through `sanitizeHtml(html)` (`@platform/eslint-plugin` `no-unsafe-html`).

## Guarantees

- **Fallbacks:** a missing message falls back to the default locale, then to the key; never to a crash.
- **Error text:** API errors get localized text by problem type (`problemMessage`), falling back to the server's title.
- **HTML:** sanitized HTML is a `TrustedHTML` value where the browser supports Trusted Types, so `require-trusted-types-for 'script'` holds.

Design doc: §C1 `/i18n`, `/security`, §C3 (CSP).
