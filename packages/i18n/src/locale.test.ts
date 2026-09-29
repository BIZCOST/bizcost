import { describe, expect, it } from 'vitest'
import {
  currencyDigits,
  currencySymbol,
  formatCurrency,
  formatDate,
  formatDecimal,
  formatNumber,
  formatPercent,
  formatUnitCost,
  formatWholeCurrency,
} from './format'
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

  it('show unit costs with enough digits to read, never 0.00', () => {
    // Intl puts a no-break space between the code and the amount (\s matches it).
    const cost = (amount: string, currency = 'AED') =>
      formatUnitCost('en', amount, currency).replace(/\s/g, ' ')
    expect(cost('6.666666666667')).toBe('AED 6.67')
    expect(cost('0.006666666667')).toBe('AED 0.0067')
    expect(cost('0.006')).toBe('AED 0.0060')
    expect(cost('0.05')).toBe('AED 0.050')
    expect(cost('0.5')).toBe('AED 0.50')
    // At most 6 decimals.
    expect(cost('0.000000123')).toBe('AED 0.000000')
    expect(cost('0')).toBe('AED 0.00')
    expect(cost('0.0005', 'KWD')).toBe('KWD 0.00050')
    expect(formatUnitCost('ar', '0.006666666667', 'AED')).not.toMatch(ARABIC_INDIC)
  })

  it('write the currency as formatCurrency does', () => {
    expect(currencySymbol('en', 'AED')).toBe('AED')
    expect(currencySymbol('ar', 'AED')).toBe('د.إ.')
    expect(formatCurrency('ar', '18.5', 'AED')).toContain(currencySymbol('ar', 'AED'))
    expect(formatCurrency('en', '18.5', 'KWD')).toContain(currencySymbol('en', 'KWD'))
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

  it('show percentages rounded half up, from a percent or a fraction', () => {
    const percent = (value: string, options?: Parameters<typeof formatPercent>[2]) =>
      formatPercent('en', value, options).replace(/\s/g, ' ')
    expect(percent('74.983044733039')).toBe('75.0%')
    expect(percent('40.8625')).toBe('40.9%')
    expect(percent('-13.25')).toBe('-13.3%')
    expect(percent('0.5', { ratio: true, minDigits: 0 })).toBe('50%')
    expect(percent('0.275', { ratio: true, minDigits: 0 })).toBe('27.5%')
    expect(percent('0.333333333333', { ratio: true, minDigits: 0 })).toBe('33.3%')
    // Exact beyond float precision.
    expect(percent('9007199254740993.05')).toBe('9,007,199,254,740,993.1%')
    expect(formatPercent('ar', '74.983044733039')).not.toMatch(ARABIC_INDIC)
    expect(formatPercent('ar', '74.983044733039')).toContain('75.0')
  })

  it('write a round figure in the currency, rounded half up to whole units', () => {
    const whole = (value: string) => formatWholeCurrency('en', value, 'AED').replace(/\s/g, ' ')
    expect(whole('15000')).toBe('AED 15,000')
    expect(whole('15712.666666666667')).toBe('AED 15,713')
    expect(whole('32797.5')).toBe('AED 32,798')
    expect(whole('1')).toBe('AED 1')
    expect(formatWholeCurrency('ar', '15712.67', 'AED')).toMatch(/15,713/)
    expect(formatWholeCurrency('ar', '15712.67', 'AED')).not.toMatch(ARABIC_INDIC)
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
