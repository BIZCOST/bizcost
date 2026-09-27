import type Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pow10, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { computeLine, lineError, type LineAmounts, type LineInput } from './line'
import { documentTotals } from './totals'

const line = (
  qty: string,
  unitPrice: string,
  vatRate: string,
  discount?: { percent: string } | { amount: string },
): LineInput => ({
  qty: qty as Quantity,
  unitPrice: unitPrice as Money,
  vatRate: vatRate as Percent,
  discount: discount as LineInput['discount'],
})

const decimalArb = (maxWhole: bigint, digits: number) =>
  fc
    .tuple(fc.bigInt({ min: 0n, max: maxWhole }), fc.stringMatching(new RegExp(`^\\d{${digits}}$`)))
    .map(([whole, fraction]) => (digits ? `${whole}.${fraction}` : `${whole}`))
const currencyArb = fc.constantFrom<CurrencyCode>('AED', 'KWD', 'SAR', 'OMR')
const rateArb = fc.oneof(fc.constantFrom('0', '5', '15'), decimalArb(100n, 2))
const halfUnit = (currency: CurrencyCode) => pow10(-currencyMinorUnit(currency)).dividedBy(2)
const lineArb = fc.record({
  qty: decimalArb(10_000n, 3),
  price: decimalArb(100_000n, 4),
  rate: rateArb,
  discount: fc.option(
    fc.oneof(fc.record({ percent: decimalArb(99n, 2) }), fc.record({ amount: decimalArb(50n, 3) })),
  ),
})

describe('computeLine', () => {
  it('takes the discount off before VAT and rounds each amount (AED)', () => {
    expect(computeLine(line('3', '10.50', '5', { percent: '10' }), 'AED')).toEqual({
      subtotal: '31.50',
      discount: '3.15',
      net: '28.35',
      vat: '1.42', // 1.4175
      total: '29.77',
    })
    expect(computeLine(line('3', '10.50', '5', { amount: '5' }), 'AED')).toEqual({
      subtotal: '31.50',
      discount: '5.00',
      net: '26.50',
      vat: '1.33', // 1.325 rounds up
      total: '27.83',
    })
  })

  it('handles no discount, no VAT, fractional quantities and 3-decimal currencies', () => {
    expect(computeLine(line('0.333', '12.75', '0'), 'AED')).toEqual({
      subtotal: '4.25', // 4.24575
      discount: '0.00',
      net: '4.25',
      vat: '0.00',
      total: '4.25',
    })
    expect(computeLine(line('2', '1.2345', '5', null as never), 'KWD')).toEqual({
      subtotal: '2.469',
      discount: '0.000',
      net: '2.469',
      vat: '0.123', // 0.12345
      total: '2.592',
    })
  })

  it('rounds a fixed discount and allows the whole subtotal off', () => {
    expect(computeLine(line('1', '10', '5', { amount: '1.005' }), 'AED').discount).toBe('1.01')
    expect(computeLine(line('2', '5', '5', { amount: '10' }), 'AED')).toMatchObject({
      net: '0.00',
      total: '0.00',
    })
    expect(computeLine(line('2', '5', '5', { percent: '100' }), 'AED').total).toBe('0.00')
  })

  it('reports the first problem and refuses to compute it', () => {
    const cases: [LineInput, string][] = [
      [line('-1', '10', '5'), 'negative_quantity'],
      [line('1', '-10', '5'), 'negative_price'],
      [line('1', '10', '-5'), 'negative_vat_rate'],
      [line('1', '10', '5', { percent: '-1' }), 'negative_discount'],
      [line('1', '10', '5', { percent: '100.01' }), 'discount_over_100_percent'],
      [line('1', '10', '5', { amount: '10.01' }), 'discount_over_subtotal'],
      [line('1', '10', '5', { amount: '-1' }), 'negative_discount'],
    ]
    for (const [input, error] of cases) {
      expect(lineError(input, 'AED')).toBe(error)
      expect(() => computeLine(input, 'AED')).toThrow(RangeError)
    }
    expect(lineError(line('1', '10', '5', { amount: '10.004' }), 'AED')).toBeNull()
  })

  it('rounds each amount once, within half a minor unit of the exact maths (property)', () => {
    fc.assert(
      fc.property(lineArb, currencyArb, ({ qty, price, rate, discount }, currency) => {
        const input = line(qty, price, rate, discount ?? undefined)
        if (lineError(input, currency)) return
        const out = computeLine(input, currency)
        const digits = currencyMinorUnit(currency)
        for (const value of Object.values(out)) {
          expect(value).toMatch(new RegExp(`^\\d+\\.\\d{${digits}}$`))
        }
        const near = (amount: string, exact: Decimal) =>
          toDec(amount).minus(exact).abs().lte(halfUnit(currency))
        expect(near(out.subtotal, toDec(qty).times(toDec(price)))).toBe(true)
        const exactDiscount = !discount
          ? toDec('0')
          : 'percent' in discount
            ? toDec(out.subtotal).times(toDec(discount.percent)).dividedBy(100)
            : toDec(discount.amount)
        expect(near(out.discount, exactDiscount)).toBe(true)
        expect(near(out.vat, toDec(out.net).times(toDec(rate)).dividedBy(100))).toBe(true)
        expect(toDec(out.net).lt(0)).toBe(false)
      }),
    )
  })
})

describe('documentTotals', () => {
  it('sums the rounded lines, never re-rounding the maths', () => {
    // Three lines of 0.3333 × 1 at 5 %: each is 0.33 + 0.02 VAT; the sum is 0.99 + 0.06.
    const lines = [1, 2, 3].map(() => computeLine(line('1', '0.3333', '5'), 'AED'))
    expect(documentTotals(lines, 'AED')).toEqual({
      subtotal: '0.99',
      discount: '0.00',
      net: '0.99',
      vat: '0.06',
      total: '1.05',
    })
  })

  it('is all zeros for an empty document', () => {
    expect(documentTotals([], 'KWD').total).toBe('0.000')
  })

  it('prints totals that equal the sums of the printed lines (property)', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 12 }), currencyArb, (specs, currency) => {
        const lines = specs
          .map(({ qty, price, rate, discount }) => line(qty, price, rate, discount ?? undefined))
          .filter((input) => lineError(input, currency) === null)
          .map((input) => computeLine(input, currency))
        const totals = documentTotals(lines, currency)
        const sum = (pick: (amounts: LineAmounts) => string) =>
          lines.reduce((acc, amounts) => acc.plus(toDec(pick(amounts))), toDec('0'))
        expect(toDec(totals.total).eq(sum((amounts) => amounts.total))).toBe(true)
        expect(toDec(totals.vat).eq(sum((amounts) => amounts.vat))).toBe(true)
        expect(toDec(totals.net).eq(sum((amounts) => amounts.net))).toBe(true)
        expect(totals.total).toMatch(new RegExp(`^\\d+\\.\\d{${currencyMinorUnit(currency)}}$`))
      }),
    )
  })
})
