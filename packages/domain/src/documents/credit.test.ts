import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareDecimal, plain, toDec } from '../numbers/decimal'
import type { Money, Quantity } from '../numbers/kinds'
import {
  creditError,
  creditLeft,
  creditRateVat,
  creditTotals,
  fitCredit,
  planCredit,
  type CreditedLine,
  type CreditLinePlan,
  type CreditMade,
  type CreditRequest,
} from './credit'
import { computeSale, type SaleLineInput } from './sale'
import { subtractDecimals, sumDecimals } from './split'

// What is left to refund on a line, and how a refund line is made (M3 Step 5; VAT ER Art. 60: each
// later credit starts from the value the earlier ones left). Goldens: the baker's cake refunded 20 by
// amount, then returned; three returns of a 10.00 line in fils; a price including VAT; a line with its
// own discount. Properties: never more than is left, and a line refunded whole leaves nothing.

/** A sold line as computeSale finalizes it. */
function sold(
  qty: string,
  unitPrice: string,
  opts: { vatRegistered?: boolean; includes?: boolean; discountAmount?: string } = {},
): CreditedLine {
  const vatRegistered = opts.vatRegistered ?? false
  const line: SaleLineInput = {
    kind: 'item',
    qty: qty as Quantity,
    unitPrice: unitPrice as Money,
    priceIncludesVat: opts.includes ?? false,
    vatCategory: 'standard',
    discount: opts.discountAmount ? { amount: opts.discountAmount as Money } : null,
  }
  const amounts = computeSale({ lines: [line], vatRegistered }, 'AED').lines[0]!
  return {
    qty,
    unitPrice,
    priceIncludesVat: amounts.priceIncludesVat,
    net: plain(toDec(amounts.net)),
    vat: plain(toDec(amounts.vat)),
    total: plain(toDec(amounts.total)),
  }
}

/** The refund line a plan gives, worked out as the refund document would (one partial line). */
function made(
  line: CreditedLine,
  left: ReturnType<typeof creditLeft>,
  plan: CreditLinePlan,
  by: 'quantity' | 'amount',
  vatRegistered: boolean,
): CreditMade {
  const abs = (value: string) => plain(toDec(value).abs())
  if (plan.whole) {
    return {
      by,
      qty: by === 'quantity' ? abs(plan.qty) : '0',
      net: abs(plan.net),
      vat: abs(plan.vat),
      total: abs(plan.total),
    }
  }
  const amounts = computeSale(
    {
      vatRegistered,
      lines: [
        {
          kind: 'item',
          qty: plan.qty as Quantity,
          unitPrice: plan.unitPrice as Money,
          priceIncludesVat: line.priceIncludesVat,
          vatCategory: 'standard',
          discount: plan.discountAmount ? { amount: plan.discountAmount as Money } : null,
        },
      ],
    },
    'AED',
  ).lines[0]!
  const fitted = fitCredit(left, amounts, line.priceIncludesVat)
  return {
    by,
    qty: by === 'quantity' ? abs(plan.qty) : '0',
    net: abs(fitted.net),
    vat: abs(fitted.vat),
    total: abs(fitted.total),
  }
}

function take(line: CreditedLine, so: CreditMade[], request: CreditRequest, vat = false) {
  const left = creditLeft(line, so)
  const plan = planCredit(line, left, request, 'AED')
  const credit = made(line, left, plan, request.by, vat)
  return { plan, credit, after: creditLeft(line, [...so, credit]) }
}

describe('the baker’s cake (the definition of done)', () => {
  const cake = sold('1', '150')

  it('refunded 20 by amount for a damage: a price cut of 20, the cake still sold', () => {
    const { plan, credit, after } = take(cake, [], { by: 'amount', amount: '20' })
    expect(plan).toEqual({ whole: false, qty: '-1', unitPrice: '20', discountAmount: null })
    expect(credit).toMatchObject({ net: '20', total: '20', qty: '0' })
    expect(after).toMatchObject({ qty: '1', net: '130', typed: '130' })
  })

  it('then returned: the return starts from the adjusted value, 130 (Art. 60)', () => {
    const first = take(cake, [], { by: 'amount', amount: '20' }).credit
    const { plan, after } = take(cake, [first], { by: 'quantity', qty: '1' })
    expect(plan).toEqual({ whole: true, qty: '-1', net: '-130', vat: '0', total: '-130' })
    expect(after).toMatchObject({ qty: '0', net: '0', vat: '0', total: '0' })
  })

  it('never more than is left', () => {
    const left = creditLeft(cake, [])
    expect(creditError(left, { by: 'amount', amount: '150.01' }, 'AED')).toBe('exceeds_left')
    expect(creditError(left, { by: 'quantity', qty: '2' }, 'AED')).toBe('exceeds_left')
    expect(creditError(left, { by: 'amount', amount: '0' }, 'AED')).toBe('not_positive')
    expect(creditError(left, { by: 'quantity', qty: '-1' }, 'AED')).toBe('not_positive')
    expect(creditError(left, { by: 'amount', amount: '1.005' }, 'AED')).toBe('too_many_decimals')
    expect(creditError(left, { by: 'quantity', qty: '0.0000001' }, 'AED')).toBe('too_many_decimals')
    expect(() => planCredit(cake, left, { by: 'amount', amount: '151' }, 'AED')).toThrow(RangeError)
  })
})

describe('returns by quantity', () => {
  it('three returns of a 10.00 line of 3 take 3.33, 3.34 and 3.33: nothing is left, not a fils', () => {
    const line = sold('3', '3.3333')
    expect(line.net).toBe('10')
    const first = take(line, [], { by: 'quantity', qty: '1' })
    expect(first.plan).toEqual({
      whole: false,
      qty: '-1',
      unitPrice: '3.3333',
      discountAmount: null,
    })
    expect(first.credit.net).toBe('3.33')
    // 6.67 left for 2: 3.34 is more than 1 × 3.3333 rounded, so the unit price is 3.34.
    const second = take(line, [first.credit], { by: 'quantity', qty: '1' })
    expect(second.plan).toEqual({
      whole: false,
      qty: '-1',
      unitPrice: '3.34',
      discountAmount: null,
    })
    expect(second.credit.net).toBe('3.34')
    const third = take(line, [first.credit, second.credit], { by: 'quantity', qty: '1' })
    expect(third.plan).toMatchObject({ whole: true, net: '-3.33' })
    expect(third.after).toMatchObject({ qty: '0', net: '0', total: '0' })
  })

  it('a line with its own discount: a return takes its share of the discount too', () => {
    const line = sold('4', '25', { vatRegistered: true, discountAmount: '10' })
    expect(line).toMatchObject({ net: '90', vat: '4.5', total: '94.5' })
    const { plan, credit } = take(line, [], { by: 'quantity', qty: '1' }, true)
    expect(plan).toEqual({ whole: false, qty: '-1', unitPrice: '25', discountAmount: '2.5' })
    expect(credit).toMatchObject({ net: '22.5', vat: '1.13', total: '23.63' })
  })

  it('a price including VAT: the return is typed with VAT, as the line was', () => {
    const line = sold('2', '10.5', { vatRegistered: true, includes: true })
    expect(line).toMatchObject({ net: '20', vat: '1', total: '21' })
    const first = take(line, [], { by: 'quantity', qty: '1' }, true)
    expect(first.credit).toMatchObject({ net: '10', vat: '0.5', total: '10.5' })
    const rest = take(line, [first.credit], { by: 'quantity', qty: '1' }, true)
    expect(rest.plan).toEqual({ whole: true, qty: '-1', net: '-10', vat: '-0.5', total: '-10.5' })
  })

  it('a price cut of everything left leaves the quantity to return for nothing', () => {
    const line = sold('2', '50')
    const cut = take(line, [], { by: 'amount', amount: '100' })
    expect(cut.plan).toMatchObject({ whole: true, qty: '-1', net: '-100' })
    expect(cut.after).toMatchObject({ qty: '2', net: '0', typed: '0' })
    const back = take(line, [cut.credit], { by: 'quantity', qty: '1' })
    expect(back.plan).toEqual({ whole: false, qty: '-1', unitPrice: '50', discountAmount: '50' })
    expect(back.credit.net).toBe('0')
  })

  it('creditTotals adds a refund’s lines as positive amounts', () => {
    expect(
      creditTotals([
        { net: '-20', vat: '-1', total: '-21' },
        { net: '-3.33', vat: '0', total: '-3.33' },
      ]),
    ).toEqual({ net: '23.33', vat: '1', total: '24.33' })
  })
})

describe('fitCredit', () => {
  it('keeps a part’s VAT within the VAT left (rounding of earlier parts), the net as typed', () => {
    // 8 × 0.08 = 0.64 + 0.03 VAT; after a cut of 0.30 (VAT 0.02) and 3 back (0.13 + 0.01), 0.21 and
    // no VAT are left: 3 more back (0.13, its VAT worked out 0.01) takes no VAT.
    const left = { qty: '5', net: '0.21', vat: '0', total: '0.21', typed: '0.21' }
    expect(fitCredit(left, { net: '-0.13', vat: '-0.01', total: '-0.14' }, false)).toEqual({
      net: '-0.13',
      vat: '0',
      total: '-0.13',
    })
  })

  it('with VAT included keeps the total as typed and splits it within what is left', () => {
    const left = { qty: '2', net: '0.1', vat: '0.01', total: '0.11', typed: '0.11' }
    expect(fitCredit(left, { net: '-0.09', vat: '-0.02', total: '-0.11' }, true)).toEqual({
      net: '-0.1',
      vat: '-0.01',
      total: '-0.11',
    })
    expect(fitCredit(left, { net: '-0.05', vat: '0', total: '-0.05' }, true)).toEqual({
      net: '-0.05',
      vat: '0',
      total: '-0.05',
    })
  })

  it('leaves a part within what is left unchanged', () => {
    const left = { qty: '4', net: '90', vat: '4.5', total: '94.5', typed: '90' }
    const part = { net: '-22.5', vat: '-1.13', total: '-23.63' }
    expect(fitCredit(left, part, false)).toEqual(part)
  })
})

describe('properties', () => {
  const fromCents = (v: number) => {
    const text = String(v).padStart(3, '0')
    return `${text.slice(0, -2)}.${text.slice(-2)}`
  }
  const cents = (min: number, max: number) => fc.integer({ min, max }).map(fromCents)
  const lineArb = fc.record({
    qty: fc.integer({ min: 1, max: 12 }).map(String),
    price: cents(1, 99_999),
    vatRegistered: fc.boolean(),
    includes: fc.boolean(),
  })
  const step = fc.oneof(
    fc.record({ by: fc.constant('quantity' as const), share: fc.integer({ min: 1, max: 100 }) }),
    fc.record({ by: fc.constant('amount' as const), share: fc.integer({ min: 1, max: 100 }) }),
  )

  it('credits never take more than is left, and returning what is left leaves nothing', () => {
    fc.assert(
      fc.property(lineArb, fc.array(step, { maxLength: 6 }), (spec, steps) => {
        const line = sold(spec.qty, spec.price, {
          vatRegistered: spec.vatRegistered,
          includes: spec.vatRegistered && spec.includes,
        })
        const so: CreditMade[] = []
        for (const s of steps) {
          const left = creditLeft(line, so)
          let request: CreditRequest | null = null
          if (s.by === 'quantity' && compareDecimal(left.qty, '0') > 0) {
            const q = Math.max(1, Math.floor((Number(left.qty) * s.share) / 100))
            request = { by: 'quantity', qty: String(q) }
          } else if (s.by === 'amount' && compareDecimal(left.typed, '0.01') >= 0) {
            const typedCents = toDec(left.typed).times(100).toNumber()
            const a = Math.max(1, Math.floor((typedCents * s.share) / 100))
            request = { by: 'amount', amount: fromCents(a) }
          }
          if (request === null) continue
          expect(creditError(left, request, 'AED')).toBeNull()
          const { credit, after } = take(line, so, request, spec.vatRegistered)
          const takenTyped = line.priceIncludesVat ? credit.total : credit.net
          expect(compareDecimal(takenTyped, left.typed)).toBeLessThanOrEqual(0)
          // Nothing left ever goes below zero: quantity, net, VAT or total.
          for (const value of [after.qty, after.net, after.vat, after.total, after.typed]) {
            expect(compareDecimal(value, '0')).toBeGreaterThanOrEqual(0)
          }
          so.push(credit)
        }
        // Whatever came before, the last return of what is left leaves nothing at all.
        const left = creditLeft(line, so)
        if (compareDecimal(left.qty, '0') > 0) {
          const { after } = take(line, so, { by: 'quantity', qty: left.qty }, spec.vatRegistered)
          expect(after).toMatchObject({ qty: '0', net: '0', vat: '0', total: '0', typed: '0' })
        }
      }),
      { numRuns: 1000 },
    )
  })
})

describe('creditRateVat: VAT once per rate on every credit note (PINT-AE S-09)', () => {
  const none = { charged: '0', before: { typed: '0', vat: '0' }, takesAllLeft: false }
  const at5 = (before = { typed: '0', vat: '0' }, takesAllLeft = false) => ({
    vatRate: '5',
    invoiceVat: '2469.14',
    beforeVat: { charged: '2469.14', before, takesAllLeft },
    withVat: none,
  })
  const lines = (n: number, typed: string, priceIncludesVat = false) =>
    Array.from({ length: n }, () => ({ priceIncludesVat, typed }))
  const sum = (values: readonly string[]) =>
    plain(values.reduce((a, v) => a.plus(toDec(v)), toDec('0')))

  it('34 whole lines of 1,234.57 of a 40-line invoice: 5% of their 41,975.38, not their shares', () => {
    // Each line was charged 61.72 or 61.73 (the invoice's 2,469.14 shared); the 34 at 61.73 would
    // make 2,098.82, 0.05 from 5% of 41,975.38.
    const first = creditRateVat(at5(), lines(34, '1234.57'), 'AED')
    expect(sum(first)).toBe('2098.77')
    for (const vat of first) expect(['61.72', '61.73']).toContain(vat)
    // The other 6 take all that is left: exactly the VAT left, so the two add up to the invoice's.
    const second = creditRateVat(
      at5({ typed: '41975.38', vat: '2098.77' }, true),
      lines(6, '1234.57'),
      'AED',
    )
    expect(sum(second)).toBe('370.37')
  })

  it('prices with VAT: the VAT inside the running total, never more than is left', () => {
    const basis = (before: { typed: string; vat: string }, takesAllLeft: boolean) => ({
      vatRate: '5',
      invoiceVat: '15',
      beforeVat: none,
      withVat: { charged: '15', before, takesAllLeft },
    })
    expect(
      creditRateVat(basis({ typed: '0', vat: '0' }, false), lines(1, '105', true), 'AED'),
    ).toEqual(['5'])
    expect(
      creditRateVat(basis({ typed: '210', vat: '10' }, true), lines(1, '105', true), 'AED'),
    ).toEqual(['5'])
    // Everything taken back already: nothing more.
    expect(
      creditRateVat(basis({ typed: '315', vat: '15' }, false), lines(1, '1', true), 'AED'),
    ).toEqual(['0'])
  })

  it('a rate of zero takes no VAT', () => {
    expect(creditRateVat({ ...at5(), vatRate: '0' }, lines(2, '100'), 'AED')).toEqual(['0', '0'])
  })

  it('every note is within a fils of its taxable amount × 5%, and all of them add up to the invoice', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 999_999 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 5 }),
        (cents, notes) => {
          const nets = cents.map((c) => plain(toDec(String(c)).dividedBy(100)))
          const invoiceNet = sum(nets)
          // The invoice's VAT, once on its net.
          const invoiceVat = plain(toDec(invoiceNet).times(5).dividedBy(100).toDecimalPlaces(2, 4))
          let before = { typed: '0', vat: '0' }
          const groups = Array.from({ length: notes }, (_, k) =>
            nets.filter((_, i) => i % notes === k),
          )
          groups.forEach((group, k) => {
            if (group.length === 0) return
            const all = k === groups.length - 1 || groups.slice(k + 1).every((g) => g.length === 0)
            const vat = sum(
              creditRateVat(
                {
                  vatRate: '5',
                  invoiceVat,
                  beforeVat: { charged: invoiceVat, before, takesAllLeft: all },
                  withVat: none,
                },
                group.map((typed) => ({ priceIncludesVat: false, typed })),
                'AED',
              ),
            )
            const net = sum(group)
            const exact = toDec(net).times(5).dividedBy(100).toDecimalPlaces(2, 4)
            expect(toDec(vat).minus(exact).abs().lte('0.01')).toBe(true)
            before = { typed: sum([before.typed, net]), vat: sum([before.vat, vat]) }
          })
          expect(before.vat).toBe(plain(toDec(invoiceVat)))
        },
      ),
      { numRuns: 500 },
    )
  })
})

// A rate whose lines are priced both ways (D-121, D-220: "one sale can hold both"), through the real
// engine and the rows as the API stores them (D-365). The invoice works each kind out on its own, so a
// credit note must too: weighing 1,050.00 with VAT against 1,000.00 before VAT as if they were one
// basis gave rows of 48.78 and 51.22 and left 1.22 owed on a supply cancelled whole, for ever.
describe('creditRateVat: both kinds of price at one rate', () => {
  interface Invoiced {
    readonly withVat: boolean
    readonly net: string
    readonly vat: string
    readonly total: string
  }

  const invoiceOf = (prices: readonly { typed: string; withVat: boolean }[]) => {
    const sale = computeSale(
      {
        vatRegistered: true,
        lines: prices.map((p) => ({
          kind: 'item' as const,
          qty: '1' as Quantity,
          unitPrice: p.typed as Money,
          priceIncludesVat: p.withVat,
          vatCategory: 'standard' as const,
        })),
      },
      'AED',
    )
    return {
      sale,
      lines: sale.lines.map((l, i): Invoiced => ({
        withVat: prices[i]!.withVat,
        net: l.net,
        vat: l.vat,
        total: l.total,
      })),
    }
  }

  /** The rows a note stores: what it took as typed stays, and its other amount moves with the VAT. */
  const rows = (
    invoice: readonly Invoiced[],
    taken: readonly { at: number; typed: string }[],
    before: {
      net: { typed: string; vat: string }
      gross: { typed: string; vat: string }
    },
    left: readonly string[],
  ) => {
    const after = (i: number) =>
      toDec(left[i]!)
        .minus(toDec(taken.find((t) => t.at === i)?.typed ?? '0'))
        .lte(0)
    const part = (withVat: boolean) => ({
      charged: sumDecimals(invoice.filter((l) => l.withVat === withVat).map((l) => l.vat)),
      before: withVat ? before.gross : before.net,
      takesAllLeft: invoice.every((l, i) => l.withVat !== withVat || after(i)),
    })
    const shares = creditRateVat(
      {
        vatRate: '5',
        invoiceVat: sumDecimals(invoice.map((l) => l.vat)),
        beforeVat: part(false),
        withVat: part(true),
      },
      taken.map((t) => ({ priceIncludesVat: invoice[t.at]!.withVat, typed: t.typed })),
      'AED',
    )
    return taken.map((t, k) => {
      const vat = shares[k]!
      return invoice[t.at]!.withVat
        ? { at: t.at, net: subtractDecimals(t.typed, vat), vat, total: t.typed }
        : { at: t.at, net: t.typed, vat, total: sumDecimals([t.typed, vat]) }
    })
  }

  const nothingBefore = { net: { typed: '0', vat: '0' }, gross: { typed: '0', vat: '0' } }

  it('1,000.00 before VAT and 1,050.00 with VAT, both taken back: 50.00 and 50.00, nothing left', () => {
    const { lines: invoice, sale } = invoiceOf([
      { typed: '1000', withVat: false },
      { typed: '1050', withVat: true },
    ])
    expect(sale).toMatchObject({ net: '2000.00', vat: '100.00', total: '2100.00' })
    const note = rows(
      invoice,
      [
        { at: 0, typed: '1000' },
        { at: 1, typed: '1050' },
      ],
      nothingBefore,
      ['1000', '1050'],
    )
    expect(
      note.map((r) => [plain(toDec(r.net)), plain(toDec(r.vat)), plain(toDec(r.total))]),
    ).toEqual([
      ['1000', '50', '1050'],
      ['1000', '50', '1050'],
    ])
  })

  it('100,000.00 and 105,000.00 too: the larger the amounts, the larger it used to leave', () => {
    const { lines: invoice } = invoiceOf([
      { typed: '100000', withVat: false },
      { typed: '105000', withVat: true },
    ])
    const note = rows(
      invoice,
      [
        { at: 0, typed: '100000' },
        { at: 1, typed: '105000' },
      ],
      nothingBefore,
      ['100000', '105000'],
    )
    expect(note.map((r) => plain(toDec(r.vat)))).toEqual(['5000', '5000'])
  })

  it('a deposit taken off at the rate: the two kinds never pass the VAT the invoice has left', () => {
    const note = creditRateVat(
      {
        vatRate: '5',
        // Each kind was charged 5.00; a deposit took 5.00 of VAT off the rate.
        invoiceVat: '5',
        beforeVat: { charged: '5', before: { typed: '0', vat: '0' }, takesAllLeft: true },
        withVat: { charged: '5', before: { typed: '0', vat: '0' }, takesAllLeft: true },
      },
      [
        { priceIncludesVat: false, typed: '100' },
        { priceIncludesVat: true, typed: '105' },
      ],
      'AED',
    )
    expect(note).toEqual(['2.5', '2.5'])
  })

  it("a note that finishes one kind and not the other stays inside the rule's 0.02", () => {
    // Two roundings of the first note, the invoice's own and the second note's add up: 0.0245 before the
    // kind still running gave a fils back. Its running total takes it up on the last note.
    const { lines: invoice, sale } = invoiceOf([
      { typed: '3758.39', withVat: false },
      { typed: '9684.89', withVat: true },
    ])
    const typed = ['3758.39', '9684.89']
    const first = rows(
      invoice,
      [
        { at: 0, typed: '468.10' },
        { at: 1, typed: '7060.31' },
      ],
      nothingBefore,
      typed,
    )
    const before = {
      net: { typed: '468.10', vat: first[0]!.vat },
      gross: { typed: '7060.31', vat: first[1]!.vat },
    }
    const second = rows(
      invoice,
      [
        { at: 0, typed: '3290.29' },
        { at: 1, typed: '101.00' },
      ],
      before,
      ['3290.29', '2624.58'],
    )
    const taxable = toDec(second[0]!.net).plus(toDec(second[1]!.net))
    const noteVat = toDec(second[0]!.vat).plus(toDec(second[1]!.vat))
    expect(noteVat.minus(taxable.times(5).dividedBy(100)).abs().lte('0.02')).toBe(true)
    const last = rows(
      invoice,
      [{ at: 1, typed: '2523.58' }],
      {
        net: { typed: '3758.39', vat: sumDecimals([first[0]!.vat, second[0]!.vat]) },
        gross: { typed: '7161.31', vat: sumDecimals([first[1]!.vat, second[1]!.vat]) },
      },
      ['0', '2523.58'],
    )
    const all = [...first, ...second, ...last]
    expect(compareDecimal(sumDecimals(all.map((r) => r.total)), sale.total)).toBe(0)
    expect(compareDecimal(sumDecimals(all.map((r) => r.vat)), sale.vat)).toBe(0)
  })

  const generated = fc
    .array(
      fc.record({
        cents: fc.integer({ min: 1, max: 99_999_999 }),
        withVat: fc.boolean(),
        // Which note takes this line (the last note takes whatever is left of every line).
        note: fc.integer({ min: 0, max: 3 }),
        // Half of the line is taken by an earlier note.
        split: fc.boolean(),
      }),
      { minLength: 2, maxLength: 12 },
    )
    .filter((ls) => ls.some((l) => l.withVat) && ls.some((l) => !l.withVat))
  const typedOf = (cents: number) => plain(toDec(String(cents)).dividedBy(100))

  it('a whole note on any invoice with both kinds: every row is what the invoice charged it', () => {
    fc.assert(
      fc.property(generated, (ls) => {
        const { lines: invoice, sale } = invoiceOf(
          ls.map((l) => ({ typed: typedOf(l.cents), withVat: l.withVat })),
        )
        const typed = invoice.map((l) => (l.withVat ? l.total : l.net))
        const note = rows(
          invoice,
          invoice.map((_, at) => ({ at, typed: typed[at]! })),
          nothingBefore,
          typed,
        )
        note.forEach((row, i) => {
          expect(compareDecimal(row.vat, invoice[i]!.vat)).toBe(0)
          expect(compareDecimal(row.net, invoice[i]!.net)).toBe(0)
          expect(compareDecimal(row.total, invoice[i]!.total)).toBe(0)
        })
        expect(compareDecimal(sumDecimals(note.map((r) => r.total)), sale.total)).toBe(0)
      }),
      { numRuns: 1000 },
    )
  })

  it('any notes on it, whole lines or halves: all taken back leaves nothing, each note inside S-09', () => {
    fc.assert(
      fc.property(generated, (ls) => {
        const { lines: invoice, sale } = invoiceOf(
          ls.map((l) => ({ typed: typedOf(l.cents), withVat: l.withVat })),
        )
        const left = invoice.map((l) => toDec(l.withVat ? l.total : l.net))
        const before = { net: { typed: '0', vat: '0' }, gross: { typed: '0', vat: '0' } }
        const credited = { net: '0', vat: '0', total: '0' }
        for (let k = 0; k <= 4; k++) {
          const taken = ls.flatMap((l, at) => {
            if (left[at]!.lte(0)) return []
            if (k === 4 || l.note === k) return [{ at, typed: plain(left[at]!) }]
            if (l.split && l.note > k) {
              const half = left[at]!.dividedBy(2).toDecimalPlaces(2)
              return half.gt(0) ? [{ at, typed: plain(half) }] : []
            }
            return []
          })
          if (taken.length === 0) continue
          const note = rows(
            invoice,
            taken,
            before,
            left.map((v) => plain(v)),
          )
          // PINT-AE aligned-ibrp-s-09: the note's VAT against its taxable amount × 5%, in the rule's 0.02.
          const exact = note
            .reduce((a, r) => a.plus(toDec(r.net)), toDec('0'))
            .times(5)
            .dividedBy(100)
          const noteVat = toDec(sumDecimals(note.map((r) => r.vat)))
          expect(noteVat.minus(exact).abs().lte('0.02')).toBe(true)
          note.forEach((row) => {
            left[row.at] = left[row.at]!.minus(
              toDec(invoice[row.at]!.withVat ? row.total : row.net),
            )
            const side = invoice[row.at]!.withVat ? before.gross : before.net
            side.typed = sumDecimals([side.typed, invoice[row.at]!.withVat ? row.total : row.net])
            side.vat = sumDecimals([side.vat, row.vat])
            credited.net = sumDecimals([credited.net, row.net])
            credited.vat = sumDecimals([credited.vat, row.vat])
            credited.total = sumDecimals([credited.total, row.total])
          })
        }
        expect(compareDecimal(credited.net, sale.net)).toBe(0)
        expect(compareDecimal(credited.vat, sale.vat)).toBe(0)
        expect(compareDecimal(credited.total, sale.total)).toBe(0)
      }),
      { numRuns: 1000 },
    )
  })
})
