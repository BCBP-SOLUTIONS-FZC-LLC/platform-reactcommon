import { describe, expect, it, vi } from 'vitest';
import { formatMessage, parseMessage, type FormatContext } from '../../src/i18n/messages.ts';

const ctx = (locale: string): FormatContext => {
  const rules = new Intl.PluralRules(locale);
  const nf = new Intl.NumberFormat(locale);
  return { locale, number: (n) => nf.format(n), plural: (n) => rules.select(n) };
};
const en = ctx('en');
const f = (src: string, vars?: Record<string, string | number>, c = en) => formatMessage(src, vars, c);

describe('ICU-lite messages', () => {
  it('interpolates values, formatting numbers for the locale', () => {
    expect(f('Hello {name}!', { name: 'Ali' })).toBe('Hello Ali!');
    expect(f('{n} bids', { n: 12345.5 })).toBe('12,345.5 bids');
    expect(f('{n, number} bids', { n: 1000 })).toBe('1,000 bids');
    expect(f('{n} bids', { n: 1000 }, ctx('de'))).toBe('1.000 bids');
  });

  it('leaves a missing value visible', () => {
    expect(f('Hello {name}')).toBe('Hello {name}');
    expect(f('{n, plural, one {# bid} other {# bids}}')).toBe('{n}');
  });

  it('selects English plural forms, exact matches first, with #', () => {
    const msg = '{n, plural, =0 {No bids} one {# bid} other {# bids}}';
    expect(f(msg, { n: 0 })).toBe('No bids');
    expect(f(msg, { n: 1 })).toBe('1 bid');
    expect(f(msg, { n: 1234 })).toBe('1,234 bids');
  });

  it('selects all six Arabic plural forms', () => {
    const msg = '{n, plural, zero {صفر} one {واحد} two {اثنان} few {قليل} many {كثير} other {آخر}}';
    const ar = ctx('ar');
    expect([0, 1, 2, 3, 11, 100].map((n) => f(msg, { n }, ar))).toEqual(['صفر', 'واحد', 'اثنان', 'قليل', 'كثير', 'آخر']);
  });

  it('applies offset', () => {
    const msg = '{n, plural, offset:1 =0 {nobody} =1 {{name}} one {{name} and # other} other {{name} and # others}}';
    expect(f(msg, { n: 1, name: 'Sara' })).toBe('Sara');
    expect(f(msg, { n: 2, name: 'Sara' })).toBe('Sara and 1 other');
    expect(f(msg, { n: 5, name: 'Sara' })).toBe('Sara and 4 others');
  });

  it('selects on strings, with plurals nested inside', () => {
    const msg = '{role, select, approver {{n, plural, one {# approval} other {# approvals}} pending} other {Nothing}}';
    expect(f(msg, { role: 'approver', n: 2 })).toBe('2 approvals pending');
    expect(f(msg, { role: 'member', n: 2 })).toBe('Nothing');
  });

  it('honours ICU apostrophe quoting', () => {
    expect(f("It''s {name}''s", { name: 'Omar' })).toBe("It's Omar's");
    expect(f("Use '{braces}' literally")).toBe('Use {braces} literally');
    expect(f("{n, plural, other {'#' is # here}}", { n: 3 })).toBe('# is 3 here');
    expect(f("unterminated '{x")).toBe('unterminated {x');
    expect(f("an apostrophe ' alone")).toBe("an apostrophe ' alone");
  });

  it('treats # as text outside plurals', () => {
    expect(f('Item #{id}', { id: 7 })).toBe('Item #7');
  });

  it.each([
    ['unclosed argument', 'Hello {name'],
    ['stray close', 'Hello }'],
    ['unknown type', '{d, date, short}'],
    ['plural without other', '{n, plural, one {x}}'],
    ['bad name', '{1x}'],
    ['missing selector body', '{n, plural, one x other {y}}'],
    ['bad offset', '{n, plural, offset:-1 other {x}}'],
  ])('renders a malformed message (%s) as its raw text and reports it', (_, src) => {
    expect(() => parseMessage(src)).toThrow();
    const onError = vi.fn();
    expect(formatMessage(src, {}, en, onError)).toBe(src);
    expect(onError).toHaveBeenCalledWith(src);
  });

  it('never evaluates anything', () => {
    expect(f('{constructor}', {})).toBe('{constructor}');
    expect(f('{__proto__}', {})).toBe('{__proto__}');
    expect(f('${alert(1)}', {})).toBe('${alert(1)}');
  });
});
