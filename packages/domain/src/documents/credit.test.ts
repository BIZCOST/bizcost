import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareDecimal, plain, toDec } from '../numbers/decimal'
import type { Money, Quantity } from '../numbers/kinds'
import {
  creditError,
  creditLeft,
  creditTotals,
  fitCredit,
  planCredit,
  type CreditedLine,
  type CreditLinePlan,
  type CreditMade,
  type CreditRequest,
} from './credit'
import { computeSale, type SaleLineInput } from './sale'

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
