/**
 * Localisation: locale negotiation and <html lang dir> (RTL for Arabic), per-remote message
 * namespaces with ICU-lite messages (no eval), Intl number, money and date formatting, and
 * localised problem messages. Design contract: docs/design/frontend-sdk-design.md §C1 `/i18n`.
 *
 * @packageDocumentation
 */
export {
  formatDate,
  formatMoney,
  formatNumber,
  initializeI18n,
  problemMessage,
  registerNamespace,
  setLocale,
  t,
} from './i18n.ts';
