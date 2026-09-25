import { describe, expect, it } from 'vitest'
import { currencyDigits, formatCurrency, formatDate, formatDecimal, formatNumber } from './format'
import { dir, intlLocale, negotiateLocale, resolveLocale } from './locale'

const ARABIC_INDIC = /[٠-٩۰-۹]/

describe('dir and intlLocale', () => {
  it('is RTL with Latin digits for Arabic and LTR for English', () => {
    expect(dir('ar')).toBe('rtl')
    expect(dir('en')).toBe('ltr')
    expect(intlLocale('ar')).toBe('ar-AE-u-nu-latn')
    expect(intlLocale('en')).toBe('en-AE')
  })
})

describe('negotiateLocale', () => {
  it.each([
    ['ar-AE,ar;q=0.9,en;q=0.8', 'ar'],
    ['en-US,en;q=0.9', 'en'],
    ['fr-FR,fr;q=0.9,en;q=0.5,ar;q=0.4', 'en'],
    ['fr;q=0.9,ar;q=0.7,en;q=0.8', 'en'],
    ['en;q=0,ar;q=0.1', 'ar'],
    ['EN-gb', 'en'],
    ['*', 'ar'],
    ['fr-FR', 'ar'],
    ['', 'ar'],
    [null, 'ar'],
    [undefined, 'ar'],
  ])('%s → %s', (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected)
  })
})

describe('resolveLocale', () => {
  it('prefers the profile, then the saved choice, then the browser, then Arabic', () => {
    expect(resolveLocale({ profile: 'en', saved: 'ar', acceptLanguage: 'ar' })).toBe('en')
    expect(resolveLocale({ profile: null, saved: 'en', acceptLanguage: 'ar' })).toBe('en')
    expect(resolveLocale({ saved: 'fr', acceptLanguage: 'en-US' })).toBe('en')
    expect(resolveLocale({})).toBe('ar')
  })
})

describe('formatters', () => {
  it('show Latin digits in Arabic', () => {
    expect(formatNumber('ar', 1234567)).not.toMatch(ARABIC_INDIC)
    expect(formatNumber('ar', 1234567)).toContain('1,234,567')
    expect(formatCurrency('ar', '1234.5', 'AED')).not.toMatch(ARABIC_INDIC)
    expect(formatDate('ar', '2026-09-25T08:00:00Z', { timeZone: 'Asia/Dubai' })).not.toMatch(
      ARABIC_INDIC,
    )
  })

  it('round decimal strings half up to the currency minor unit before Intl', () => {
    expect(currencyDigits('AED')).toBe(2)
    expect(currencyDigits('KWD')).toBe(3)
    expect(formatCurrency('en', '1234.505', 'AED')).toContain('1,234.51')
    expect(formatCurrency('en', '1234.5', 'AED')).toContain('1,234.50')
    expect(formatCurrency('en', '-0.005', 'AED')).toContain('0.01')
    expect(formatCurrency('en', '0.0005', 'KWD')).toContain('0.001')
    expect(formatCurrency('en', '1234.5', 'AED')).toContain('AED')
    // Exact beyond float precision.
    expect(formatCurrency('en', '9007199254740993.125', 'AED')).toContain(
      '9,007,199,254,740,993.13',
    )
  })

  it('show decimals with exactly the requested digits', () => {
    expect(formatDecimal('en', '0.125', 2)).toBe('0.13')
    expect(formatDecimal('ar', '12', 1)).toBe('12.0')
  })

  it('format dates in the given time zone', () => {
    expect(
      formatDate('en', '2026-09-25T22:30:00Z', { timeZone: 'Asia/Dubai', day: 'numeric' }),
    ).toBe('26')
  })
})
