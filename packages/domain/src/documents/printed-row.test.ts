import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { VatCategory } from '../catalog/keys'
import { fixed, plain, roundHalfUp, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { creditLeft, fitCredit, planCredit, type CreditMade } from './credit'
import { printedRow, printedVatColumn } from './printed-row'
import {
  computeSale,
  saleError,
  solveRoundAmount,
  type SaleAmounts,
  type SaleInput,
  type SaleLineAmounts,
  type SaleLineInput,
} from './sale'
import { sumDecimals } from './split'

// The columns of an invoice and a credit note always add up (D-360; the owner's request of 2026-11-04):
// every row, on every document the sales engine can make: discounts, a document discount, "Round the
// total", mixed rates and prices that include VAT. These fail on the old layout, whose amount was
// subtotal − the line's own discount: it knew nothing of the document's discount or "Round the total".

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

/** A row as a person checks it: its printed values only. */
function checkRow(line: SaleLineAmounts, qty: string, unitPrice: string): void {
  const row = printedRow(
    {
      qty,
      unitPrice,
      priceIncludesVat: line.priceIncludesVat,
      vatRate: line.vatRate,
      net: line.net,
      total: line.total,
    },
    'AED',
  )
  const asTyped = roundHalfUp(toDec(qty).times(toDec(unitPrice)), 2)
  const reached = asTyped.minus(toDec(row.discount))
  // Unit price × qty − discount = before VAT, or the total when the price includes VAT.
  expect(reached.eq(toDec(row.includesVat ? line.total : line.net))).toBe(true)
  // Before VAT + VAT = total.
  expect(toDec(line.net).plus(toDec(line.vat)).eq(toDec(line.total))).toBe(true)
}

/** The whole document as printed: every row, and the columns against the totals. */
function checkDocument(input: SaleInput, amounts: SaleAmounts): void {
  amounts.lines.forEach((line, i) => checkRow(line, input.lines[i]!.qty, input.lines[i]!.unitPrice))
  // The printed line VAT adds up to each rate's VAT, the before-VAT column to its taxable amount.
  for (const rate of amounts.rates) {
    const at = amounts.lines.filter(
      (line) => line.vatCategory === rate.vatCategory && line.vatRate === rate.vatRate,
    )
    expect(sumDecimals(at.map((line) => line.vat))).toBe(sumDecimals([rate.vat]))
    expect(sumDecimals(at.map((line) => line.net))).toBe(sumDecimals([rate.net]))
  }
  // The line totals plus any rounding difference come to what the document asks.
  expect(
    sumDecimals([...amounts.lines.map((line) => line.total), amounts.roundingDifference]),
  ).toBe(sumDecimals([amounts.payable]))
  expect(sumDecimals(amounts.lines.map((line) => line.total))).toBe(sumDecimals([amounts.total]))
}

const discountOf = (input: SaleInput, line: number, amounts = computeSale(input, 'AED')) => {
  const l = amounts.lines[line]!
  return printedRow(
    {
      qty: input.lines[line]!.qty,
      unitPrice: input.lines[line]!.unitPrice,
      priceIncludesVat: l.priceIncludesVat,
      vatRate: l.vatRate,
      net: l.net,
      total: l.total,
    },
    'AED',
  )
}

describe('a printed row', () => {
  it('a price before VAT with no discount prints 0.00, and reads to before VAT', () => {
    const input: SaleInput = { lines: [item('120', '45')], vatRegistered: true }
    expect(discountOf(input, 0)).toEqual({
      includesVat: false,
      asTyped: '5400.00',
      discount: '0.00',
    })
    checkDocument(input, computeSale(input, 'AED'))
  })

  it("the line's own discount and its share of the document's: 2 lines, 10 % off the document", () => {
    const input: SaleInput = {
      lines: [item('1', '1000', { discount: { amount: m('100') } }), item('1', '100')],
      vatRegistered: true,
      discount: { percent: '10' as Percent },
    }
    const amounts = computeSale(input, 'AED')
    expect(amounts.lines.map((line) => line.net)).toEqual(['810.00', '90.00'])
    // 1,000 − 190 = 810 (100 of its own and 90 of the document's); 100 − 10 = 90.
    expect(discountOf(input, 0, amounts).discount).toBe('190.00')
    expect(discountOf(input, 1, amounts).discount).toBe('10.00')
    checkDocument(input, amounts)
  })

  it('a price with VAT stays as typed, the row reads to the total: 3 × 10.00 with VAT', () => {
    const input: SaleInput = {
      lines: [item('3', '10', { priceIncludesVat: true })],
      vatRegistered: true,
    }
    const amounts = computeSale(input, 'AED')
    expect(amounts.lines[0]).toMatchObject({ net: '28.57', vat: '1.43', total: '30.00' })
    expect(discountOf(input, 0, amounts)).toEqual({
      includesVat: true,
      asTyped: '30.00',
      discount: '0.00',
    })
    checkDocument(input, amounts)
  })

  it('"Round the total" down: D-221\'s 1,120.00 → 1,100.00, before VAT and with VAT', () => {
    const before: SaleInput = {
      lines: [item('1', '1066.67')],
      vatRegistered: true,
    }
    const solved = solveRoundAmount(before, m('1100.00'), 'AED')
    expect(solved.adjustment).toBe('-19.05')
    expect(discountOf(before, 0, solved.sale).discount).toBe('19.05')
    checkDocument(before, solved.sale)

    const withVat: SaleInput = {
      lines: [item('1', '1120', { priceIncludesVat: true })],
      vatRegistered: true,
    }
    const reached = solveRoundAmount(withVat, m('1100.00'), 'AED')
    expect(reached.sale.lines[0]).toMatchObject({ net: '1047.62', vat: '52.38', total: '1100.00' })
    // With VAT: 1,120.00 − 20.00 = 1,100.00, not the adjustment's 19.05 before VAT.
    expect(discountOf(withVat, 0, reached.sale).discount).toBe('20.00')
    checkDocument(withVat, reached.sale)
  })

  it('"Round the total" up: a negative discount, the only one that makes the row add up', () => {
    const input: SaleInput = { lines: [item('1', '1000')], vatRegistered: true }
    const solved = solveRoundAmount(input, m('1100.00'), 'AED')
    expect(solved.sale.lines[0]!.net).toBe('1047.62')
    expect(discountOf(input, 0, solved.sale).discount).toBe('-47.62')
    checkDocument(input, solved.sale)
  })

  it('a rounding difference stays outside the rows: 1,000.12 at 5 % is 1,000.11 + 0.01', () => {
    const input: SaleInput = { lines: [item('1', '952.5')], vatRegistered: true }
    const solved = solveRoundAmount(input, m('1000.12'), 'AED')
    expect(solved.sale).toMatchObject({ total: '1000.11', roundingDifference: '0.01' })
    checkDocument(input, solved.sale)
  })

  it("mixed rates, rounded: D-221's 2,600.00 → 2,500.00", () => {
    const input: SaleInput = {
      lines: [item('1', '2000'), item('1', '500', { vatCategory: 'zero_rated' })],
      vatRegistered: true,
    }
    const solved = solveRoundAmount(input, m('2500.00'), 'AED')
    expect(solved.sale.vat).toBe('96.15')
    expect(discountOf(input, 0, solved.sale).discount).toBe('76.92')
    expect(discountOf(input, 1, solved.sale).discount).toBe('19.23')
    checkDocument(input, solved.sale)
  })

  it("a credit note's line taking back all that was left of a discounted line: price and quantity kept, no stored discount", () => {
    // What credit-notes.ts stores: the invoice line's price and quantity, its net as what is left.
    expect(
      printedRow(
        {
          qty: '10',
          unitPrice: '100',
          priceIncludesVat: false,
          vatRate: '5',
          net: '900.00',
          total: '945.00',
        },
        'AED',
      ).discount,
    ).toBe('100.00')
  })

  describe("the last of a line's returns in parts: a fils of the earlier rounding reads as a discount", () => {
    /** Each return's row, through the real credit maths and the stored price and quantity. */
    const returned = (qty: string, unitPrice: string, returns: readonly string[]) => {
      const sale = computeSale({ lines: [item(qty, unitPrice)], vatRegistered: true }, 'AED')
        .lines[0]!
      const line = {
        qty,
        unitPrice,
        priceIncludesVat: false,
        net: sale.net,
        vat: sale.vat,
        total: sale.total,
      }
      const made: CreditMade[] = []
      return returns.map((taken) => {
        const left = creditLeft(line, made)
        const plan = planCredit(line, left, { by: 'quantity', qty: taken }, 'AED')
        const part = plan.whole
          ? { net: plan.net, vat: plan.vat, total: plan.total }
          : fitCredit(
              left,
              computeSale(
                {
                  lines: [
                    item(plan.qty, plan.unitPrice, {
                      discount: plan.discountAmount ? { amount: m(plan.discountAmount) } : null,
                    }),
                  ],
                  vatRegistered: true,
                },
                'AED',
              ).lines[0]!,
              false,
            )
        const net = plain(toDec(part.net).abs())
        const total = plain(toDec(part.total).abs())
        made.push({ by: 'quantity', qty: taken, net, vat: plain(toDec(part.vat).abs()), total })
        const printed = printedRow(
          {
            qty: taken,
            unitPrice: plan.whole ? unitPrice : plan.unitPrice,
            priceIncludesVat: false,
            vatRate: '5',
            net,
            total,
          },
          'AED',
        )
        // The row still adds up: quantity × price − the discount printed = before VAT.
        expect(toDec(printed.asTyped).minus(toDec(printed.discount)).eq(toDec(net))).toBe(true)
        return { net, discount: printed.discount }
      })
    }

    it('2.5 × 101.01 returned as 1.2 and 1.3: −0.01 on the last, on a line never discounted', () => {
      expect(returned('2.5', '101.01', ['1.2', '1.3'])).toEqual([
        { net: '121.21', discount: '0.00' },
        { net: '131.32', discount: '-0.01' },
      ])
    })

    it('3 × 10.01 returned as 1.5 and 1.5: 0.01 on the last', () => {
      expect(returned('3', '10.01', ['1.5', '1.5'])).toEqual([
        { net: '15.02', discount: '0.00' },
        { net: '15.01', discount: '0.01' },
      ])
    })

    it('a whole quantity returned in whole quantities at a 2-decimal price: always 0.00', () => {
      expect(returned('10', '45.55', ['3', '7'])).toEqual([
        { net: '136.65', discount: '0.00' },
        { net: '318.85', discount: '0.00' },
      ])
    })
  })

  it('a deposit taken off: qty −1, its price positive, reads to its negative amounts with 0.00', () => {
    expect(
      printedRow(
        {
          qty: '-1',
          unitPrice: '5000.00',
          priceIncludesVat: false,
          vatRate: '5',
          net: '-5000.00',
          total: '-5250.00',
        },
        'AED',
      ).discount,
    ).toBe('0.00')
  })

  it('a business not registered for VAT: its price is only a price', () => {
    const input: SaleInput = {
      lines: [item('2', '500', { priceIncludesVat: true, discount: { amount: m('100') } })],
      vatRegistered: false,
    }
    const amounts = computeSale(input, 'AED')
    expect(discountOf(input, 0, amounts)).toEqual({
      includesVat: false,
      asTyped: '1000.00',
      discount: '100.00',
    })
    checkDocument(input, amounts)
  })

  it('a currency of 3 decimals prints its own digits', () => {
    expect(
      printedRow(
        {
          qty: '3',
          unitPrice: '1.125',
          priceIncludesVat: false,
          vatRate: null,
          net: '3.000',
          total: '3.000',
        },
        'KWD',
      ),
    ).toEqual({ includesVat: false, asTyped: '3.375', discount: '0.375' })
  })
})

// ---------------------------------------------------------------------------------------------------
// The property: every row of every document the engine makes
// ---------------------------------------------------------------------------------------------------

/** A decimal string up to `maxWhole` with `digits` decimals, from whole numbers. */
const decimal = (maxWhole: number, digits: number) =>
  fc.integer({ min: 0, max: maxWhole * 10 ** digits }).map((value) => {
    const text = String(value).padStart(digits + 1, '0')
    return `${text.slice(0, -digits)}.${text.slice(-digits)}`
  })

const lineArbitrary = (priced: fc.Arbitrary<boolean>): fc.Arbitrary<SaleLineInput> =>
  fc
    .record({
      kind: fc.constantFrom('item', 'item', 'item', 'delivery', 'charge'),
      vatCategory: fc.constantFrom<VatCategory>('standard', 'standard', 'zero_rated', 'exempt'),
      qty: decimal(50, 3).filter((qty) => toDec(qty).gt(0)),
      unitPrice: decimal(5000, 2),
      priceIncludesVat: priced,
      percent: fc.option(decimal(40, 2), { nil: null }),
    })
    .map(({ kind, vatCategory, qty, unitPrice, priceIncludesVat, percent }): SaleLineInput => {
      const base = {
        qty: qty as Quantity,
        unitPrice: unitPrice as Money,
        priceIncludesVat,
        discount: percent === null ? null : { percent: percent as Percent },
      }
      return kind === 'delivery'
        ? { kind: 'delivery', ...base }
        : { kind: kind as 'item' | 'charge', vatCategory, ...base }
    })

/** Prices all before VAT, all with VAT, or of both kinds (the engine then refuses a doc discount). */
const documents: fc.Arbitrary<SaleInput> = fc
  .constantFrom<'before' | 'with' | 'both'>('before', 'with', 'both')
  .chain((ways) =>
    fc.record({
      lines: fc.array(
        lineArbitrary(ways === 'both' ? fc.boolean() : fc.constant(ways === 'with')),
        { minLength: 1, maxLength: 8 },
      ),
      vatRegistered: fc.boolean(),
      discount: fc.oneof(
        { weight: 2, arbitrary: fc.constant(null) },
        {
          weight: 1,
          arbitrary: decimal(30, 2).map((percent) => ({ percent: percent as Percent })),
        },
      ),
    }),
  )
  .filter((input) => saleError(input, 'AED') === null)

describe('the columns always add up', () => {
  it('every row reads right, and the columns come to the rates and the total', () => {
    fc.assert(
      fc.property(documents, (input) => {
        checkDocument(input, computeSale(input, 'AED'))
      }),
      { numRuns: 1000 },
    )
  })

  it('with "Round the total", to a total lower or higher than the document\'s', () => {
    fc.assert(
      fc.property(documents, fc.integer({ min: 40, max: 160 }), (input, percent) => {
        const total = computeSale(input, 'AED').total
        const wanted = fixed(toDec(total).times(percent).dividedBy(100), 2)
        const solved = solveRoundAmount(input, m(wanted), 'AED')
        checkDocument(
          {
            ...input,
            adjustment: solved.adjustment,
            roundingDifference: solved.roundingDifference,
          },
          solved.sale,
        )
      }),
      { numRuns: 1000 },
    )
  })

  it('a discount is never negative unless the total was rounded up', () => {
    fc.assert(
      fc.property(documents, (input) => {
        const amounts = computeSale(input, 'AED')
        amounts.lines.forEach((_, i) => {
          expect(toDec(discountOf(input, i, amounts).discount).lt(0)).toBe(false)
        })
      }),
      { numRuns: 500 },
    )
  })
})

describe('the VAT column', () => {
  const line = (vatCategory: VatCategory | null, vatRate: string | null) => ({
    vatCategory,
    vatRate,
  })

  it('one rate is said once in its heading, whichever way the rate is written', () => {
    expect(printedVatColumn([line('standard', '5'), line('standard', '5.000000')])).toEqual({
      kind: 'one',
      vatCategory: 'standard',
      vatRate: '5',
    })
    expect(printedVatColumn([line('zero_rated', '0'), line('zero_rated', '0')])).toMatchObject({
      kind: 'one',
      vatCategory: 'zero_rated',
    })
    expect(printedVatColumn([line('exempt', '0')])).toMatchObject({
      kind: 'one',
      vatCategory: 'exempt',
    })
  })

  it('5 % with a zero-rated or an exempt line is mixed, and zero-rated with exempt too', () => {
    expect(printedVatColumn([line('standard', '5'), line('zero_rated', '0')])).toEqual({
      kind: 'mixed',
    })
    expect(printedVatColumn([line('standard', '5'), line('exempt', '0')])).toEqual({
      kind: 'mixed',
    })
    expect(printedVatColumn([line('zero_rated', '0'), line('exempt', '0')])).toEqual({
      kind: 'mixed',
    })
  })

  it('no line carries VAT: none', () => {
    expect(printedVatColumn([line(null, null)])).toEqual({ kind: 'none' })
    expect(printedVatColumn([])).toEqual({ kind: 'none' })
  })
})
