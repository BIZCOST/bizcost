import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { VatCategory } from '../catalog/keys'
import { roundHalfUp, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import type { CurrencyCode } from '../numbers/rounding'
import type { LineDiscount } from './line'
import { computePurchase } from './purchase'
import {
  computeSale,
  pintLineOf,
  roundTheTotalError,
  saleError,
  solveRoundAmount,
  type SaleAmounts,
  type SaleInput,
  type SaleLineInput,
} from './sale'
import { sumDecimals } from './split'

// Sales documents (M3 Step 1, D-220, D-221; the owner's answer Q4 of D-218): VAT once per VAT rate,
// split back over the lines by largest remainder; prices before VAT or including it; zero-rated and
// exempt kept apart; nothing for a business not registered for VAT; "Round the total" before VAT over
// the rates by their net with a rounding difference of at most 0.02; refunds as negative quantities;
// every line maps for e-invoicing (IBR-147-AE). The owner's examples are golden tests; the rest are
// fast-check properties.

const m = (value: string) => value as Money
const item = (
  qty: string,
  unitPrice: string,
  over: Partial<Omit<SaleLineInput, 'kind'>> & { vatCategory?: VatCategory } = {},
): SaleLineInput => ({
  kind: 'item',
  qty: qty as Quantity,
  unitPrice: m(unitPrice),
  priceIncludesVat: false,
  vatCategory: 'standard',
  ...over,
})
const delivery = (amount: string, over: Partial<SaleLineInput> = {}): SaleLineInput =>
  ({
    kind: 'delivery',
    qty: '1' as Quantity,
    unitPrice: m(amount),
    priceIncludesVat: false,
    ...over,
  }) as SaleLineInput
const charge = (amount: string, vatCategory: VatCategory = 'standard'): SaleLineInput => ({
  kind: 'charge',
  qty: '1' as Quantity,
  unitPrice: m(amount),
  priceIncludesVat: false,
  vatCategory,
})
const sale = (lines: SaleLineInput[], over: Partial<SaleInput> = {}) =>
  computeSale({ lines, vatRegistered: true, ...over }, 'AED')

describe('VAT once per rate, split back over the lines (Q4)', () => {
  it('7 lines of AED 10.10 at 5 %: VAT 3.54 (four lines of 0.51, three of 0.50), not 3.57; total 74.24', () => {
    const lines = Array.from({ length: 7 }, () => item('1', '10.10'))
    const amounts = sale(lines)
    expect(amounts.lines.map((line) => line.vat)).toEqual([
      '0.51',
      '0.51',
      '0.51',
      '0.51',
      '0.50',
      '0.50',
      '0.50',
    ])
    expect(amounts).toMatchObject({ net: '70.70', vat: '3.54', total: '74.24', payable: '74.24' })
    expect(amounts.rates).toEqual([
      { vatCategory: 'standard', vatRate: '5', net: '70.70', vat: '3.54' },
    ])
    expect(amounts.lines[0]).toEqual({
      kind: 'item',
      vatCategory: 'standard',
      vatRate: '5',
      priceIncludesVat: false,
      subtotal: '10.10',
      discount: '0.00',
      documentDiscount: '0.00',
      adjustment: '0.00',
      net: '10.10',
      vat: '0.51',
      total: '10.61',
    })
  })

  it('purchases keep their per-line rounding: the same 7 lines bought are VAT 3.57 (D-107)', () => {
    const purchase = computePurchase(
      {
        lines: Array.from({ length: 7 }, () => ({
          kind: 'material' as const,
          qty: '1' as Quantity,
          unitPrice: m('10.10'),
          vatRate: '5' as Percent,
        })),
        vatInCost: false,
      },
      'AED',
    )
    expect(purchase).toMatchObject({ net: '70.70', vat: '3.57', total: '74.27' })
  })

  it('Today’s sales: 40 lattes × 18.00 + 25 croissants × 9.00 = 945.00 before VAT, VAT 47.25, total 992.25', () => {
    expect(sale([item('40', '18.00'), item('25', '9.00')])).toMatchObject({
      net: '945.00',
      vat: '47.25',
      total: '992.25',
    })
  })

  it('zero-rated and exempt are both 0 % and stay apart; delivery is standard-rated', () => {
    const amounts = sale([
      item('1', '100'),
      item('1', '40', { vatCategory: 'exempt' }),
      item('2', '30', { vatCategory: 'zero_rated' }),
      delivery('20'),
    ])
    expect(amounts.rates).toEqual([
      { vatCategory: 'standard', vatRate: '5', net: '120.00', vat: '6.00' },
      { vatCategory: 'zero_rated', vatRate: '0', net: '60.00', vat: '0.00' },
      { vatCategory: 'exempt', vatRate: '0', net: '40.00', vat: '0.00' },
    ])
    expect(amounts.lines.map((line) => [line.vatCategory, line.vat])).toEqual([
      ['standard', '5.00'],
      ['exempt', '0.00'],
      ['zero_rated', '0.00'],
      ['standard', '1.00'],
    ])
  })

  it('a business not registered for VAT: no category, no rate, no VAT, whatever the product says', () => {
    const amounts = computeSale(
      {
        vatRegistered: false,
        lines: [item('1', '150', { priceIncludesVat: true }), delivery('20')],
      },
      'AED',
    )
    expect(amounts.rates).toEqual([
      { vatCategory: null, vatRate: null, net: '170.00', vat: '0.00' },
    ])
    for (const line of amounts.lines) {
      expect(line).toMatchObject({ vatCategory: null, vatRate: null, priceIncludesVat: false })
      expect(line.vat).toBe('0.00')
    }
    expect(amounts).toMatchObject({ net: '170.00', vat: '0.00', total: '170.00' })
    expect(amounts.vatRegistered).toBe(false)
  })
})

describe('prices that include VAT (D-121)', () => {
  it('120 lattes at 18.90 with VAT = 2,268.00: 2,160.00 before VAT (18.00 each) + 108.00', () => {
    const line = item('120', '18.90', { priceIncludesVat: true })
    const amounts = sale([line])
    expect(amounts).toMatchObject({ net: '2160.00', vat: '108.00', total: '2268.00' })
    expect(pintLineOf(line, amounts.lines[0]!, 'AED')).toEqual({
      quantity: '120',
      netPrice: '18',
      baseQuantity: '1',
      allowances: '0.00',
      charges: '0.00',
      lineNet: '2160.00',
    })
  })

  it('the rate’s gross stays exact: VAT = round(gross × 5 ÷ 105) once, each line keeps its gross', () => {
    // 10.00 + 10.00 + 10.00 = 30.00 with VAT: 1.43 once (not 3 × 0.48 = 1.44), lines 0.48, 0.48, 0.47.
    const lines = [1, 2, 3].map(() => item('1', '10', { priceIncludesVat: true }))
    const amounts = sale(lines)
    expect(amounts).toMatchObject({ net: '28.57', vat: '1.43', total: '30.00' })
    expect(amounts.lines.map((line) => [line.net, line.vat, line.total])).toEqual([
      ['9.52', '0.48', '10.00'],
      ['9.52', '0.48', '10.00'],
      ['9.53', '0.47', '10.00'],
    ])
  })

  it('a net per unit that is not exact maps for the line’s quantity (IBT-149)', () => {
    const line = item('3', '10', { priceIncludesVat: true })
    const amounts = sale([line])
    expect(amounts.lines[0]).toMatchObject({ net: '28.57', vat: '1.43', total: '30.00' })
    expect(pintLineOf(line, amounts.lines[0]!, 'AED')).toMatchObject({
      quantity: '3',
      netPrice: '28.57',
      baseQuantity: '3',
    })
  })

  it('a gross no net reaches exactly (1 in 21 at 5 %) keeps the gross: 0.10 = 0.10 + 0.00', () => {
    // 0.10 × 5 % = 0.005 would round to 0.01: S-09 holds within 0.01 (PINT-AE allows 0.02).
    expect(sale([item('1', '0.10', { priceIncludesVat: true })])).toMatchObject({
      net: '0.10',
      vat: '0.00',
      total: '0.10',
    })
  })

  it('mixed on one rate: VAT is the exact VAT of both kinds rounded once', () => {
    // 100 before VAT (5.00 exact) + 21.00 with VAT (1.00 exact) = 6.00 once.
    const amounts = sale([item('1', '100'), item('1', '21', { priceIncludesVat: true })])
    expect(amounts.rates[0]).toMatchObject({ net: '120.00', vat: '6.00' })
    expect(amounts.lines.map((line) => line.total)).toEqual(['105.00', '21.00'])
  })
})

describe('discounts and charges', () => {
  it('a line discount (% or amount) comes off before VAT', () => {
    const amounts = sale([
      item('5', '650', { discount: { percent: '10' as Percent } }),
      item('2', '50', { discount: { amount: m('20') } }),
    ])
    expect(amounts.lines.map((line) => [line.subtotal, line.discount, line.net])).toEqual([
      ['3250.00', '325.00', '2925.00'],
      ['100.00', '20.00', '80.00'],
    ])
    expect(amounts).toMatchObject({ net: '3005.00', vat: '150.25' })
  })

  it('the fit-out company’s invoice: 13,725.00 + VAT 686.25 = 14,411.25', () => {
    const amounts = sale([
      item('120', '45'),
      item('300', '18'),
      item('5', '650', { discount: { percent: '10' as Percent } }),
    ])
    expect(amounts).toMatchObject({ net: '13725.00', vat: '686.25', total: '14411.25' })
  })

  it('the document discount comes off the item lines by their net; delivery and charges keep theirs', () => {
    const amounts = sale([item('1', '300'), item('1', '100'), delivery('20'), charge('10')], {
      discount: { amount: m('40') },
    })
    expect(amounts.lines.map((line) => [line.documentDiscount, line.net])).toEqual([
      ['30.00', '270.00'],
      ['10.00', '90.00'],
      ['0.00', '20.00'],
      ['0.00', '10.00'],
    ])
    expect(amounts.documentDiscount).toBe('40.00')
    expect(
      sale([item('1', '300'), item('1', '100')], { discount: { percent: '10' as Percent } }),
    ).toMatchObject({ documentDiscount: '40.00', net: '360.00', vat: '18.00' })
  })

  it('a discount on a price that includes VAT is typed with VAT, and comes off before VAT is worked out', () => {
    // 21.00 − 1.05 = 19.95 with VAT: 0.95 VAT, 19.00 before VAT.
    const amounts = sale([
      item('1', '21', { priceIncludesVat: true, discount: { amount: m('1.05') } }),
    ])
    expect(amounts.lines[0]).toMatchObject({
      discount: '1.05',
      net: '19.00',
      vat: '0.95',
      total: '19.95',
    })
  })
})

describe('refunds and credits: negative quantities', () => {
  it('7 lines of −10.10 give back exactly what the sale charged: VAT −3.54, total −74.24', () => {
    const amounts = sale(Array.from({ length: 7 }, () => item('-1', '10.10')))
    expect(amounts).toMatchObject({ net: '-70.70', vat: '-3.54', total: '-74.24' })
    expect(amounts.lines.map((line) => line.vat)).toEqual([
      '-0.51',
      '-0.51',
      '-0.51',
      '-0.51',
      '-0.50',
      '-0.50',
      '-0.50',
    ])
  })

  it('one document is all sold or all taken back', () => {
    expect(
      saleError({ vatRegistered: true, lines: [item('1', '5'), item('-1', '5')] }, 'AED'),
    ).toEqual({ code: 'mixed_signs', line: 1 })
  })
})

describe('what a sale refuses', () => {
  const error = (lines: SaleLineInput[], over: Partial<SaleInput> = {}) =>
    saleError({ vatRegistered: true, lines, ...over }, 'AED')

  it('says the first problem, and computeSale throws it', () => {
    expect(error([item('0', '5')])).toEqual({ code: 'zero_quantity', line: 0 })
    expect(error([item('1', '-5')])).toEqual({ code: 'negative_price', line: 0 })
    expect(error([item('1', '5', { discount: { amount: m('6') } })])).toEqual({
      code: 'discount_over_subtotal',
      line: 0,
    })
    expect(error([delivery('5')], { discount: { amount: m('1') } })).toEqual({
      code: 'no_item_line',
    })
    expect(error([item('1', '5')], { discount: { amount: m('6') } })).toEqual({
      code: 'document_discount_over_net',
    })
    expect(error([item('1', '5')], { discount: { percent: '101' as Percent } })).toEqual({
      code: 'document_discount_over_100_percent',
    })
    // A croissant at 100 before VAT and a cake at 105 with VAT: AED 10 off would be neither 10 off
    // the net nor 10 off the total. A zero-rated line priced either way is the same both ways.
    const mixed = [item('1', '100'), item('1', '105', { priceIncludesVat: true })]
    for (const discount of [{ amount: m('10') }, { percent: '10' as Percent }]) {
      expect(error(mixed, { discount })).toEqual({ code: 'document_discount_mixed_prices' })
    }
    expect(error(mixed, { discount: { amount: m('0') } })).toBeNull()
    expect(error(mixed, { discount: { amount: m('10') }, vatRegistered: false })).toBeNull()
    expect(
      error(
        [item('1', '100'), item('1', '50', { priceIncludesVat: true, vatCategory: 'exempt' })],
        {
          discount: { amount: m('10') },
        },
      ),
    ).toBeNull()
    expect(
      error([item('1', '100'), delivery('20', { priceIncludesVat: true })], {
        discount: { amount: m('10') },
      }),
    ).toBeNull()
    expect(error([item('1', '5')], { adjustment: m('-5.01') })).toEqual({
      code: 'adjustment_over_net',
    })
    expect(error([item('1', '5')], { adjustment: m('-0.005') })).toEqual({
      code: 'too_many_decimals',
    })
    expect(error([item('1', '5')], { roundingDifference: m('0.03') })).toEqual({
      code: 'rounding_difference_too_large',
    })
    expect(error([], { adjustment: m('1') })).toEqual({ code: 'no_line' })
    expect(error([item('1', '5')])).toBeNull()
    expect(() => sale([item('0', '5')])).toThrow('Invalid sale: zero_quantity (line 1)')
  })
})

describe('Round the total (D-221)', () => {
  it('1,120.00 → 1,100.00: −19.05 before VAT, VAT 52.38', () => {
    const input: SaleInput = { vatRegistered: true, lines: [item('1', '1066.67')] }
    expect(computeSale(input, 'AED').total).toBe('1120.00')
    const rounded = solveRoundAmount(input, m('1100.00'), 'AED')
    expect(rounded).toMatchObject({ adjustment: '-19.05', roundingDifference: '0.00' })
    expect(rounded.sale).toMatchObject({
      net: '1047.62',
      vat: '52.38',
      total: '1100.00',
      payable: '1100.00',
      adjustment: '-19.05',
    })
  })

  it('the same with prices that include VAT: 1,120.00 with VAT → 1,100.00', () => {
    const input: SaleInput = {
      vatRegistered: true,
      lines: [item('1', '1120', { priceIncludesVat: true })],
    }
    const rounded = solveRoundAmount(input, m('1100'), 'AED')
    expect(rounded.adjustment).toBe('-19.05')
    expect(rounded.sale).toMatchObject({ net: '1047.62', vat: '52.38', payable: '1100.00' })
  })

  it('mixed rates, 2,000 (5 %) + 500 (0 %) = 2,600.00 → 2,500.00: −76.92 and −19.23 before VAT, VAT 96.15', () => {
    const input: SaleInput = {
      vatRegistered: true,
      lines: [item('1', '2000'), item('1', '500', { vatCategory: 'zero_rated' })],
    }
    expect(computeSale(input, 'AED').total).toBe('2600.00')
    const rounded = solveRoundAmount(input, m('2500.00'), 'AED')
    expect(rounded.adjustment).toBe('-96.15')
    expect(rounded.sale.lines.map((line) => [line.adjustment, line.net, line.vat])).toEqual([
      ['-76.92', '1923.08', '96.15'],
      ['-19.23', '480.77', '0.00'],
    ])
    expect(rounded.sale).toMatchObject({ vat: '96.15', total: '2500.00', payable: '2500.00' })
  })

  it('an unreachable 1,000.12 at 5 % gives 1,000.11 + a rounding difference of 0.01', () => {
    const input: SaleInput = { vatRegistered: true, lines: [item('1', '1000')] }
    const rounded = solveRoundAmount(input, m('1000.12'), 'AED')
    expect(rounded).toMatchObject({ adjustment: '-47.51', roundingDifference: '0.01' })
    expect(rounded.sale).toMatchObject({
      net: '952.49',
      vat: '47.62',
      total: '1000.11',
      roundingDifference: '0.01',
      payable: '1000.12',
    })
  })

  it('splits over the lines by their net and rounds up too; a refund rounds in its own sign', () => {
    const up = solveRoundAmount(
      { vatRegistered: true, lines: [item('1', '30'), item('1', '64.76')] },
      m('100'),
      'AED',
    )
    expect(up.sale.payable).toBe('100.00')
    expect(toDec(up.adjustment).gt(0)).toBe(true)
    const refund = solveRoundAmount(
      { vatRegistered: true, lines: [item('-1', '1000')] },
      m('-1000.12'),
      'AED',
    )
    expect(refund).toMatchObject({ adjustment: '47.51', roundingDifference: '-0.01' })
    expect(refund.sale).toMatchObject({ total: '-1000.11', payable: '-1000.12' })
  })

  it('a business not registered for VAT reaches any total exactly', () => {
    const rounded = solveRoundAmount(
      { vatRegistered: false, lines: [item('3', '33.33'), delivery('20')] },
      m('100'),
      'AED',
    )
    expect(rounded).toMatchObject({ adjustment: '-19.99', roundingDifference: '0.00' })
    expect(rounded.sale.payable).toBe('100.00')
  })

  it('refuses a total of the other sign, too many decimals, or an empty document', () => {
    const input: SaleInput = { vatRegistered: true, lines: [item('1', '10')] }
    expect(roundTheTotalError(input, m('-1'), 'AED')).toEqual({ code: 'wanted_opposite_sign' })
    expect(roundTheTotalError(input, m('9.999'), 'AED')).toEqual({
      code: 'wanted_too_many_decimals',
    })
    expect(roundTheTotalError({ vatRegistered: true, lines: [] }, m('1'), 'AED')).toEqual({
      code: 'no_line',
    })
    expect(roundTheTotalError(input, m('0'), 'AED')).toBeNull()
    expect(() => solveRoundAmount(input, m('-1'), 'AED')).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------

const decimal = (max: number, places: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: 10 ** places - 1 }))
    .map(([whole, fraction]) =>
      places === 0 ? String(whole) : `${whole}.${String(fraction).padStart(places, '0')}`,
    )
const positive = (max: number, places: number) =>
  decimal(max, places).filter((value) => toDec(value).gt(0))
const category = fc.constantFrom<VatCategory>('standard', 'standard', 'zero_rated', 'exempt')
const lineDiscount: fc.Arbitrary<LineDiscount | null> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: decimal(100, 2).map((percent) => ({ percent: percent as Percent })) },
  { weight: 1, arbitrary: decimal(5, 2).map((amount) => ({ amount: m(amount) })) },
)
const saleLine: fc.Arbitrary<SaleLineInput> = fc
  .record({
    kind: fc.constantFrom('item', 'item', 'item', 'delivery', 'charge'),
    qty: fc.oneof(positive(50, 0), positive(20, 3)),
    unitPrice: fc.oneof(decimal(500, 2), decimal(200, 4)),
    priceIncludesVat: fc.boolean(),
    discount: lineDiscount,
    vatCategory: category,
  })
  .map((line) => {
    const base = {
      qty: line.qty as Quantity,
      unitPrice: m(line.unitPrice),
      priceIncludesVat: line.priceIncludesVat,
      discount: line.discount,
    }
    return line.kind === 'delivery'
      ? { kind: 'delivery' as const, ...base }
      : { kind: line.kind as 'item' | 'charge', vatCategory: line.vatCategory, ...base }
  })
const saleInput: fc.Arbitrary<SaleInput> = fc
  .record({
    lines: fc.array(saleLine, { minLength: 1, maxLength: 8 }),
    vatRegistered: fc.boolean(),
    discount: fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: decimal(30, 2).map((percent) => ({ percent: percent as Percent })) },
    ),
  })
  .filter((input) => saleError(input, 'AED') === null)

/** The same document taken back: every quantity negated. */
const mirrored = (input: SaleInput): SaleInput => ({
  ...input,
  lines: input.lines.map((line) => ({ ...line, qty: `-${line.qty}` as Quantity })),
})
const negate = (value: string) => (toDec(value).isZero() ? value : `-${value}`)
/** Every amount of a computed sale, negated. */
function negated(amounts: SaleAmounts): SaleAmounts {
  const money = <T extends object>(record: T): T =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        typeof value === 'string' && /^-?\d+\.\d+$/.test(value) ? negate(value) : value,
      ]),
    ) as T
  return {
    ...money(amounts),
    lines: amounts.lines.map(money),
    rates: amounts.rates.map(money),
  }
}

describe('properties of sales documents', () => {
  it('VAT per rate = net × rate (S-09; within 0.01 where prices include VAT); line VAT adds up to it', () => {
    fc.assert(
      fc.property(saleInput, (input) => {
        const amounts = computeSale(input, 'AED')
        const inclusive = input.vatRegistered && input.lines.some((line) => line.priceIncludesVat)
        for (const rate of amounts.rates) {
          const expected = roundHalfUp(
            toDec(rate.net)
              .times(toDec(rate.vatRate ?? '0'))
              .dividedBy(100),
            2,
          )
          const off = toDec(rate.vat).minus(expected).abs()
          expect(off.lte(inclusive ? '0.01' : '0')).toBe(true)
          const own = amounts.lines.filter((line) => line.vatCategory === rate.vatCategory)
          expect(toDec(sumDecimals(own.map((line) => line.vat))).eq(toDec(rate.vat))).toBe(true)
          expect(toDec(sumDecimals(own.map((line) => line.net))).eq(toDec(rate.net))).toBe(true)
        }
        expect(toDec(sumDecimals(amounts.rates.map((r) => r.vat))).eq(toDec(amounts.vat))).toBe(
          true,
        )
        expect(toDec(amounts.net).plus(toDec(amounts.vat)).eq(toDec(amounts.total))).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('a line whose price includes VAT keeps its gross after discounts as its total', () => {
    fc.assert(
      fc.property(saleInput, (input) => {
        const amounts = computeSale(input, 'AED')
        amounts.lines.forEach((line) => {
          if (!line.priceIncludesVat) return
          const gross = toDec(line.subtotal)
            .minus(toDec(line.discount))
            .minus(toDec(line.documentDiscount))
          expect(toDec(line.total).eq(gross)).toBe(true)
        })
      }),
      { numRuns: 300 },
    )
  })

  it('a document discount means one thing: the net falls by it (prices before VAT) or the total (with VAT)', () => {
    const discounted: fc.Arbitrary<SaleInput> = fc
      .record({
        lines: fc.array(saleLine, { minLength: 1, maxLength: 8 }),
        vatRegistered: fc.boolean(),
        discount: fc.oneof(
          decimal(50, 2).map((amount) => ({ amount: m(amount) })),
          decimal(30, 2).map((percent) => ({ percent: percent as Percent })),
        ),
      })
      .filter((input) => saleError(input, 'AED') === null)
    fc.assert(
      fc.property(discounted, (input) => {
        const after = computeSale(input, 'AED')
        const before = computeSale({ ...input, discount: null }, 'AED')
        const discount = toDec(after.documentDiscount)
        const taxed = input.lines.filter((_, i) => toDec(after.lines[i]!.vatRate ?? '0').gt(0))
        const taxedItems = taxed.filter((line) => line.kind === 'item')
        if (taxedItems.every((line) => !line.priceIncludesVat)) {
          expect(toDec(before.net).minus(toDec(after.net)).eq(discount)).toBe(true)
        } else {
          // Exact when every taxed line includes VAT; a taxed charge priced before VAT in the same
          // rate moves that rate's one rounding by at most 0.01.
          const off = toDec(before.total).minus(toDec(after.total)).minus(discount).abs()
          const allWithVat = taxed.every((line) => line.priceIncludesVat)
          expect(off.lte(allWithVat ? '0' : '0.01')).toBe(true)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('a business not registered for VAT never gets a VAT amount', () => {
    fc.assert(
      fc.property(saleInput, (input) => {
        const amounts = computeSale({ ...input, vatRegistered: false }, 'AED')
        expect(amounts.vat).toBe('0.00')
        for (const line of amounts.lines) {
          expect(line.vat).toBe('0.00')
          expect(line.vatCategory).toBeNull()
          expect(line.vatRate).toBeNull()
        }
        expect(amounts.rates.every((rate) => rate.vatRate === null)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('a refund mirrors its sale: every amount negated', () => {
    fc.assert(
      fc.property(saleInput, (input) => {
        expect(computeSale(mirrored(input), 'AED')).toEqual(negated(computeSale(input, 'AED')))
      }),
      { numRuns: 300 },
    )
  })

  it('every line maps for e-invoicing: quantity × net price ÷ base quantity + charges − allowances = its net (IBR-147-AE)', () => {
    const maps = (input: SaleInput, currency: CurrencyCode) => {
      const amounts = computeSale(input, currency)
      input.lines.forEach((line, i) => {
        const pint = pintLineOf(line, amounts.lines[i]!, currency)
        expect(toDec(pint.baseQuantity).gt(0)).toBe(true)
        expect(toDec(pint.netPrice).decimalPlaces()).toBeLessThanOrEqual(4)
        const computed = toDec(pint.quantity)
          .times(toDec(pint.netPrice).dividedBy(toDec(pint.baseQuantity)))
          .plus(toDec(pint.charges))
          .minus(toDec(pint.allowances))
        expect(roundHalfUp(computed, 2).eq(toDec(pint.lineNet))).toBe(true)
        expect(toDec(pint.lineNet).eq(toDec(amounts.lines[i]!.net).abs())).toBe(true)
      })
    }
    fc.assert(
      fc.property(saleInput, fc.boolean(), (input, refund) => {
        maps(refund ? mirrored(input) : input, 'AED')
      }),
      { numRuns: 500 },
    )
  })

  it('a typed total is reached within the rounding difference; no line goes below zero', () => {
    fc.assert(
      fc.property(
        saleInput,
        fc.integer({ min: 0, max: 200 }),
        fc.boolean(),
        (input, percent, refund) => {
          const document = refund ? mirrored(input) : input
          const total = toDec(computeSale(document, 'AED').total)
          const wanted = roundHalfUp(total.times(percent).dividedBy(100), 2).toString() as Money
          const rounded = solveRoundAmount(document, wanted, 'AED')
          expect(toDec(rounded.sale.payable).eq(toDec(wanted))).toBe(true)
          const difference = toDec(rounded.roundingDifference).abs()
          expect(difference.lte('0.02')).toBe(true)
          // Never more than the wanted total: the difference is in the document's sign.
          expect(toDec(rounded.sale.total).abs().lte(toDec(wanted).abs())).toBe(true)
          for (const line of rounded.sale.lines) {
            expect(
              toDec(line.net)
                .times(refund ? -1 : 1)
                .gte(0),
            ).toBe(true)
            expect(
              toDec(line.total)
                .times(refund ? -1 : 1)
                .gte(0),
            ).toBe(true)
          }
          expect(
            toDec(sumDecimals(rounded.sale.lines.map((line) => line.adjustment))).eq(
              toDec(rounded.adjustment),
            ),
          ).toBe(true)
          // VAT per rate is still worked out once on its net.
          for (const rate of rounded.sale.rates) {
            const expected = roundHalfUp(
              toDec(rate.net)
                .times(toDec(rate.vatRate ?? '0'))
                .dividedBy(100),
              2,
            )
            expect(toDec(rate.vat).minus(expected).abs().lte('0.01')).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
