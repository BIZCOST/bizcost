import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareDecimal, pow10, toDec } from './decimal'
import { asMoney, asPercent, asQuantity, asUnitCost, checkDecimal } from './kinds'
import {
  CURRENCY_MINOR_UNITS,
  currencyMinorUnit,
  fitsCurrency,
  isCurrencyCode,
  roundCost,
  roundDocument,
  roundForDisplay,
  type CurrencyCode,
} from './rounding'

const decimalArb = fc
  .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.stringMatching(/^\d{1,8}$/))
  .map(([negative, whole, fraction]) => `${negative ? '-' : ''}${whole}.${fraction}`)
const currencyArb = fc.constantFrom(...(Object.keys(CURRENCY_MINOR_UNITS) as CurrencyCode[]))

describe('currency minor units', () => {
  it('match ISO 4217 as Intl knows it', () => {
    for (const code of Object.keys(CURRENCY_MINOR_UNITS) as CurrencyCode[]) {
      const intl = new Intl.NumberFormat('en', { style: 'currency', currency: code })
      expect(currencyMinorUnit(code), code).toBe(intl.resolvedOptions().maximumFractionDigits)
    }
    expect(currencyMinorUnit('AED')).toBe(2)
    expect(currencyMinorUnit('KWD')).toBe(3)
  })

  it('refuses a currency outside the table', () => {
    expect(isCurrencyCode('AED')).toBe(true)
    expect(isCurrencyCode('XYZ')).toBe(false)
    expect(isCurrencyCode('toString')).toBe(false)
    expect(() => currencyMinorUnit('JPY' as CurrencyCode)).toThrow(RangeError)
  })
})

describe('roundDocument', () => {
  it('rounds half away from zero to the minor unit, with exactly its digits', () => {
    expect(roundDocument('1.005', 'AED')).toBe('1.01')
    expect(roundDocument('1.004999', 'AED')).toBe('1.00')
    expect(roundDocument('-1.005', 'AED')).toBe('-1.01')
    expect(roundDocument('1.2', 'AED')).toBe('1.20')
    expect(roundDocument('0.0005', 'KWD')).toBe('0.001')
    expect(roundDocument('-0.0004', 'BHD')).toBe('0.000')
    expect(roundDocument('72', 'OMR')).toBe('72.000')
  })

  it('mirrors negatives, stays within half a minor unit and is idempotent (property)', () => {
    fc.assert(
      fc.property(decimalArb, currencyArb, (value, currency) => {
        const rounded = roundDocument(value, currency)
        const digits = currencyMinorUnit(currency)
        expect(rounded).toMatch(new RegExp(`^-?\\d+\\.\\d{${digits}}$`))
        const negated = toDec(value).neg().toString()
        expect(toDec(roundDocument(negated, currency)).eq(toDec(rounded).neg())).toBe(true)
        expect(roundDocument(rounded, currency)).toBe(rounded)
        const gap = toDec(rounded).minus(toDec(value)).abs()
        expect(gap.lte(pow10(-digits).dividedBy(2))).toBe(true)
      }),
    )
  })
})

describe('fitsCurrency', () => {
  it('takes at most the minor unit (trailing zeros are fine), never rounds', () => {
    expect(fitsCurrency('10.5', 'AED')).toBe(true)
    expect(fitsCurrency('10.5000', 'AED')).toBe(true)
    expect(fitsCurrency('10.005', 'AED')).toBe(false)
    expect(fitsCurrency('10.005', 'KWD')).toBe(true)
    expect(fitsCurrency('0.0001', 'KWD')).toBe(false)
  })
})

describe('roundCost', () => {
  it('keeps 12 decimals, never the currency', () => {
    expect(roundCost('0.006')).toBe('0.006')
    expect(roundCost('6.6666666666666666')).toBe('6.666666666667')
    expect(roundCost('0.0000000000005')).toBe('0.000000000001')
    expect(roundCost('-0.0000000000004')).toBe('0')
  })
})

describe('roundForDisplay', () => {
  it('prints exactly the requested decimals', () => {
    expect(roundForDisplay('1.2', 2)).toBe('1.20')
    expect(roundForDisplay('6.666666666667', 2)).toBe('6.67')
    expect(roundForDisplay('0.0066666', 4)).toBe('0.0067')
    expect(roundForDisplay('2.5', 0)).toBe('3')
    expect(roundForDisplay('-2.5', 0)).toBe('-3')
    expect(() => roundForDisplay('1', -1)).toThrow(RangeError)
    expect(() => roundForDisplay('1', 1.5)).toThrow(RangeError)
  })

  it('refuses anything but a decimal string', () => {
    for (const value of ['1e3', 'NaN', '', ' 1', '.5']) {
      expect(() => roundForDisplay(value, 2)).toThrow(RangeError)
    }
  })
})

describe('decimal kinds', () => {
  it('check the column of each kind', () => {
    expect(checkDecimal('72.0000', 'money')).toBeNull()
    expect(checkDecimal('9999999999999999.9999', 'money')).toBeNull()
    expect(checkDecimal('10000000000000000', 'money')).toBe('too_large')
    expect(checkDecimal('0.00001', 'money')).toBe('too_many_decimals')
    expect(checkDecimal('-12.5', 'quantity')).toBeNull()
    expect(checkDecimal('0.000000000001', 'unitCost')).toBeNull()
    expect(checkDecimal('0.0000000000001', 'costAmount')).toBe('too_many_decimals')
    expect(checkDecimal('999.999999', 'percent')).toBeNull()
    expect(checkDecimal('1e3', 'percent')).toBe('invalid')
  })

  it('brand values that fit and throw on the rest', () => {
    expect(asMoney('72.00')).toBe('72.00')
    expect(asQuantity('12000')).toBe('12000')
    expect(asUnitCost('0.006')).toBe('0.006')
    expect(asPercent('5')).toBe('5')
    expect(() => asMoney('1.23456')).toThrow(RangeError)
    expect(() => asQuantity('١٢')).toThrow(RangeError)
  })

  it('compare numerically, whatever the printed digits', () => {
    expect(compareDecimal('72', '72.0000')).toBe(0)
    expect(compareDecimal('-1', '0.5')).toBe(-1)
    expect(compareDecimal('0.10', '0.09')).toBe(1)
  })
})
