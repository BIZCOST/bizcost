import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseNumber } from './parse'

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const toArabic = (text: string) => text.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)] ?? d)

/** Canonical decimal strings: no leading zeros, no trailing fraction zeros, never "-0". */
const canonicalArb = fc
  .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.stringMatching(/^\d{0,8}$/))
  .map(([negative, whole, digits]) => {
    const fraction = digits.replace(/0+$/, '')
    const body = fraction ? `${whole}.${fraction}` : `${whole}`
    return negative && body !== '0' ? `-${body}` : body
  })

/** Groups the integer part in threes with `separator` ("1234567.5" → "1,234,567.5"). */
function group(value: string, separator: string): string {
  const [whole = '', fraction] = value.split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const grouped = whole.replace('-', '').replace(/\B(?=(\d{3})+$)/g, separator)
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

describe('parseNumber', () => {
  it('reads Arabic-Indic and Persian digits and the Arabic separators', () => {
    expect(parseNumber('١٢٫٥')).toEqual({ ok: true, value: '12.5' })
    expect(parseNumber('۱۲۳۴')).toEqual({ ok: true, value: '1234' })
    expect(parseNumber('١٬٢٣٤٬٥٦٧٫٨٩')).toEqual({ ok: true, value: '1234567.89' })
  })

  it('accepts thousands separators only in groups of three', () => {
    expect(parseNumber('1,234.50')).toEqual({ ok: true, value: '1234.5' })
    expect(parseNumber('12,345,678')).toEqual({ ok: true, value: '12345678' })
    const refused = [
      '1,5',
      '0,123',
      '12,3456',
      '1,00,000',
      '1,234٬567',
      ',123',
      '1,234,',
      '1,234.5,6',
    ]
    for (const value of refused) {
      expect(parseNumber(value)).toEqual({ ok: false, error: 'invalid' })
    }
  })

  it('strips direction marks and reads the minus sign', () => {
    expect(parseNumber('\u061c-١٢')).toEqual({ ok: true, value: '-12' })
    expect(parseNumber('\u200f\u221272.5\u200e')).toEqual({ ok: true, value: '-72.5' })
  })

  it('returns canonical strings', () => {
    expect(parseNumber('  007.500 ')).toEqual({ ok: true, value: '7.5' })
    expect(parseNumber('-0.000')).toEqual({ ok: true, value: '0' })
  })

  it('refuses what zDecimal refuses', () => {
    expect(parseNumber('   ')).toEqual({ ok: false, error: 'required' })
    for (const value of [
      '+5',
      '.5',
      '5.',
      '1e5',
      'NaN',
      'Infinity',
      '0x10',
      '1 000',
      '- 5',
      '--5',
    ]) {
      expect(parseNumber(value)).toEqual({ ok: false, error: 'invalid' })
    }
    expect(parseNumber('9'.repeat(41))).toEqual({ ok: false, error: 'invalid' })
  })

  it('checks the column of a kind', () => {
    expect(parseNumber('72.5', 'money')).toEqual({ ok: true, value: '72.5' })
    expect(parseNumber('1.23456', 'money')).toEqual({ ok: false, error: 'too_many_decimals' })
    expect(parseNumber('1.2345000', 'money')).toEqual({ ok: true, value: '1.2345' })
    expect(parseNumber('1'.repeat(17), 'money')).toEqual({ ok: false, error: 'too_large' })
    expect(parseNumber('0.0000001', 'quantity')).toEqual({ ok: false, error: 'too_many_decimals' })
    expect(parseNumber('0.000000000001', 'unitCost')).toEqual({ ok: true, value: '0.000000000001' })
    expect(parseNumber('1000', 'percent')).toEqual({ ok: false, error: 'too_large' })
  })

  it('reads any canonical decimal back unchanged, in any script and grouping (property)', () => {
    fc.assert(
      fc.property(canonicalArb, fc.constantFrom('', ',', '٬'), fc.boolean(), (value, sep, ar) => {
        let typed = sep ? group(value, sep) : value
        if (ar) typed = toArabic(typed).replace('.', '٫')
        expect(parseNumber(typed)).toEqual({ ok: true, value })
      }),
    )
  })

  it('always returns the wire form zDecimal accepts (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'0123456789٠١٩.,٫٬-\u2212 \u200f') }),
        (s) => {
          const result = parseNumber(s)
          if (result.ok) expect(result.value).toMatch(/^-?\d+(?:\.\d+)?$/)
        },
      ),
    )
  })
})
