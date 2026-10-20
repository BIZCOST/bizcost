import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { VatCategory } from '../catalog/keys'
import { plain, roundHalfUp, toDec } from '../numbers/decimal'
import type { Money, Percent } from '../numbers/kinds'
import {
  allocatePayments,
  applyDeductions,
  CREDIT_REASON_LAW,
  CREDIT_REASONS,
  creditNoteAsksCountedElsewhere,
  creditNoteCounts,
  creditNoteKindOf,
  creditNoteValues,
  deductionsOf,
  invoiceAsksCountedElsewhere,
  invoiceCounts,
  invoiceCreditState,
  invoiceKindFor,
  invoiceOverdue,
  partOfRates,
  restOfRates,
  taxDocumentDueBy,
  taxDocumentLate,
  vatPointDateOf,
  type DocumentRate,
} from './invoice'

// Invoices and credit notes (M3 Step 8): goldens from the plan's definition of done (the fit-out's 30 /
// 40 / 30 stages, the workshop's deposit and final invoice, the credit note's values) and properties:
// parts add up to the source to the fils with every invoice's VAT within a fils of its net × the rate
// (PINT-AE S-09), deposit VAT + final VAT = the VAT on the work, payments never counted twice.

const m = (value: string) => value as Money
const rate = (
  net: string,
  vat: string,
  category: VatCategory | null = 'standard',
  r: string | null = '5',
): DocumentRate => ({
  vatCategory: category,
  vatRate: r as Percent | null,
  net: m(net),
  vat: m(vat),
})

/** |VAT − net × rate ÷ 100| (the PINT-AE S-09 residual) of one rate. */
const residual = (r: DocumentRate) =>
  toDec(r.vat)
    .minus(
      toDec(r.net)
        .times(toDec(r.vatRate ?? '0'))
        .dividedBy(100),
    )
    .abs()

describe('kinds, reasons and counting once', () => {
  it('a VAT-registered business issues tax documents, one that is not plain ones (Q26)', () => {
    expect(invoiceKindFor(true)).toBe('tax_invoice')
    expect(invoiceKindFor(false)).toBe('invoice')
    expect(creditNoteKindOf('tax_invoice')).toBe('tax_credit_note')
    expect(creditNoteKindOf('invoice')).toBe('credit_note')
  })

  it('each reason maps one to one to VAT DL Art. 61(1), PINT-AE BTAE-03 and MD 243 Art. 6(2)', () => {
    expect(CREDIT_REASONS.map((r) => CREDIT_REASON_LAW[r].pintAe)).toEqual([
      'DL8.61.1.A',
      'DL8.61.1.B',
      'DL8.61.1.C',
      'DL8.61.1.D',
      'DL8.61.1.E',
    ])
    expect(CREDIT_REASONS.map((r) => CREDIT_REASON_LAW[r].vatLaw)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
    expect(new Set(CREDIT_REASONS.map((r) => CREDIT_REASON_LAW[r].md243))).toEqual(
      new Set(['cancelled', 'reduced', 'returned', 'error']),
    )
    // VD (volume discount) is never offered: every credit note names its invoice (IBR-055-AE).
    expect(CREDIT_REASONS.some((r) => CREDIT_REASON_LAW[r].pintAe === 'VD')).toBe(false)
  })

  it('an invoice counts unless its order, its sale, the final invoice or recorded sales count it', () => {
    const base = { fromOrder: false, fromSale: false, isDeposit: false, countedElsewhere: null }
    expect(invoiceCounts(base)).toBe(true)
    expect(invoiceCounts({ ...base, countedElsewhere: false })).toBe(true)
    expect(invoiceCounts({ ...base, countedElsewhere: true })).toBe(false)
    expect(invoiceCounts({ ...base, fromOrder: true })).toBe(false)
    expect(invoiceCounts({ ...base, fromSale: true })).toBe(false)
    expect(invoiceCounts({ ...base, isDeposit: true })).toBe(false)
  })

  it('asks "already in your recorded sales?" only when such sales exist and nothing else counts it', () => {
    const base = { fromOrder: false, fromSale: false, isDeposit: false, hasRecordedSales: true }
    expect(invoiceAsksCountedElsewhere(base)).toBe(true)
    expect(invoiceAsksCountedElsewhere({ ...base, hasRecordedSales: false })).toBe(false)
    expect(invoiceAsksCountedElsewhere({ ...base, fromOrder: true })).toBe(false)
    expect(invoiceAsksCountedElsewhere({ ...base, fromSale: true })).toBe(false)
    expect(invoiceAsksCountedElsewhere({ ...base, isDeposit: true })).toBe(false)
  })

  it('a credit note lowers sales once its work counted; on an invoice counted elsewhere it asks', () => {
    const counted = { workCounted: true, countedElsewhere: null }
    expect(creditNoteCounts(counted, null)).toBe(true)
    // A deposit invoice before its final invoice, an order's invoice before the delivery: it bills less.
    const notYet = { workCounted: false, countedElsewhere: null }
    expect(creditNoteCounts(notYet, null)).toBe(false)
    expect(creditNoteAsksCountedElsewhere(notYet)).toBe(false)
    expect(creditNoteAsksCountedElsewhere({ workCounted: false, countedElsewhere: true })).toBe(
      false,
    )
    const elsewhere = { workCounted: true, countedElsewhere: true }
    expect(creditNoteAsksCountedElsewhere(elsewhere)).toBe(true)
    expect(creditNoteAsksCountedElsewhere(counted)).toBe(false)
    expect(creditNoteCounts(elsewhere, true)).toBe(false)
    expect(creditNoteCounts(elsewhere, false)).toBe(true)
    expect(creditNoteCounts({ workCounted: true, countedElsewhere: false }, null)).toBe(true)
  })

  it('the 14-day notes: due on the 14th day after, late from the 15th', () => {
    expect(taxDocumentDueBy('2026-10-01')).toBe('2026-10-15')
    expect(taxDocumentLate('2026-10-01', '2026-10-15')).toBe(false)
    expect(taxDocumentLate('2026-10-01', '2026-10-16')).toBe(true)
    expect(taxDocumentDueBy('2026-12-25')).toBe('2027-01-08')
  })

  it('IBT-007 (the VAT point date) is the date of supply only when it is earlier than the issue', () => {
    expect(vatPointDateOf('2026-10-18', '2026-10-05')).toBe('2026-10-05')
    expect(vatPointDateOf('2026-10-18', '2026-10-18')).toBeNull()
    expect(vatPointDateOf('2026-10-18', '2026-10-25')).toBeNull()
    expect(vatPointDateOf('2026-10-18', null)).toBeNull()
  })

  it('credit states and overdue', () => {
    expect(invoiceCreditState('14411.25', '0')).toBe('none')
    expect(invoiceCreditState('14411.25', '1890.00')).toBe('partly')
    expect(invoiceCreditState('14411.25', '14411.25')).toBe('credited')
    expect(invoiceOverdue('2026-10-10', '5.00', '2026-10-11')).toBe(true)
    expect(invoiceOverdue('2026-10-10', '0', '2026-10-11')).toBe(false)
    expect(invoiceOverdue('2026-10-10', '5.00', '2026-10-10')).toBe(false)
    expect(invoiceOverdue(null, '5.00', '2026-10-11')).toBe(false)
  })
})

describe('stages and deposits: goldens', () => {
  it('30 / 40 / 30 of 10,000.00 + VAT give 3,150.00, 4,200.00 and 3,150.00, the last exactly the rest', () => {
    const source = [rate('10000.00', '500.00')]
    const first = partOfRates(source, [], m('3150.00'), 'AED')
    expect(first).toEqual([{ ...rate('3000.00', '150.00'), gross: '3150.00' }])
    const second = partOfRates(source, first, m('4200.00'), 'AED')
    expect(second).toEqual([{ ...rate('4000.00', '200.00'), gross: '4200.00' }])
    const rest = restOfRates(source, [...first, ...second], 'AED')
    expect(rest).toEqual([{ ...rate('3000.00', '150.00'), gross: '3150.00' }])
  })

  it('a part of two rates is shared by what is left of each, VAT only on the taxed one', () => {
    const source = [rate('2000.00', '100.00'), rate('500.00', '0', 'zero_rated', '0')]
    const half = partOfRates(source, [], m('1300.00'), 'AED')
    expect(half).toEqual([
      { ...rate('1000.00', '50.00'), gross: '1050.00' },
      { ...rate('250.00', '0.00', 'zero_rated', '0'), gross: '250.00' },
    ])
  })

  it('the workshop: a deposit of 5,250.00 on 20,000 + VAT, then the final invoice of 15,750.00', () => {
    const work = [rate('20000.00', '1000.00')]
    const deposit = partOfRates(work, [], m('5250.00'), 'AED')
    expect(deposit).toEqual([{ ...rate('5000.00', '250.00'), gross: '5250.00' }])
    const final = applyDeductions(work, deductionsOf([{ id: 'dep-1', rates: deposit }]), 'AED')
    expect(final).toEqual({
      rates: [rate('15000.00', '750.00')],
      net: '15000.00',
      vat: '750.00',
      total: '15750.00',
    })
  })

  it('a deduction over its rate, or of a rate the work has not, is refused', () => {
    const work = [rate('100.00', '5.00')]
    expect(
      applyDeductions(work, [{ ...rate('200.00', '10.00'), depositInvoiceId: 'd' }], 'AED'),
    ).toBe('deduction_over_net')
    expect(
      applyDeductions(
        work,
        [{ ...rate('10.00', '0', 'zero_rated', '0'), depositInvoiceId: 'd' }],
        'AED',
      ),
    ).toBe('deduction_unknown_rate')
  })

  it('a part over what is left is refused', () => {
    expect(() => partOfRates([rate('100.00', '5.00')], [], m('105.01'), 'AED')).toThrow(RangeError)
  })
})

describe('what is owed: payments of an order counted toward its invoices (A2)', () => {
  it('a deposit paid on the order pays the deposit invoice first', () => {
    expect(allocatePayments('5250', [{ need: '5250' }, { need: '15750' }])).toEqual(['5250', '0'])
  })

  it('the last invoice takes all that is left (paid beyond: money back on it)', () => {
    expect(allocatePayments('300', [{ need: '100' }, { need: '100' }])).toEqual(['100', '200'])
    expect(allocatePayments('50', [{ need: '100' }, { need: '100' }])).toEqual(['50', '0'])
    expect(allocatePayments('0', [{ need: '100' }])).toEqual(['0'])
  })
})

describe("a credit note's values (ER Art. 60(1)(e))", () => {
  it('a second credit note starts from the value the first left', () => {
    const first = creditNoteValues(m('13725.00'), [], m('1800.00'), m('90.00'), 'AED')
    expect(first).toEqual({
      valueBefore: '13725.00',
      valueAfter: '11925.00',
      difference: '1800.00',
      vat: '90.00',
    })
    const second = creditNoteValues(m('13725.00'), [m('1800.00')], m('500.00'), m('25.00'), 'AED')
    expect(second).toMatchObject({ valueBefore: '11925.00', valueAfter: '11425.00' })
    expect(() => creditNoteValues(m('100.00'), [m('90.00')], m('20.00'), m('1.00'), 'AED')).toThrow(
      RangeError,
    )
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------

/** A source of 1–3 rates, its VAT on its net (prices before VAT) or taken out of its gross. */
const sourceArb = fc
  .array(
    fc.record({
      fils: fc.bigInt({ min: 1n, max: 50_000_000n }),
      kind: fc.constantFrom<['standard', string] | ['zero_rated', string]>(
        ['standard', '5'],
        ['zero_rated', '0'],
      ),
      gross: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((rates) => {
    // One rate of each kind (a document has one standard and one zero-rated rate at most).
    const seen = new Set<string>()
    return rates
      .filter((r) => (seen.has(r.kind[0]) ? false : (seen.add(r.kind[0]), true)))
      .map((r) => {
        const amount = toDec(r.fils.toString()).dividedBy(100)
        const percent = toDec(r.kind[1])
        let net = amount
        let vat = roundHalfUp(amount.times(percent).dividedBy(100), 2)
        if (r.gross) {
          vat = roundHalfUp(amount.times(percent).dividedBy(percent.plus(100)), 2)
          net = amount.minus(vat)
        }
        return rate(plain(net), plain(vat), r.kind[0], r.kind[1])
      })
  })

const totalOf = (rates: readonly DocumentRate[]) =>
  rates.reduce((acc, r) => acc.plus(toDec(r.net)).plus(toDec(r.vat)), toDec('0'))

describe('properties', () => {
  it('stages add up to the source to the fils, each invoice within a fils of S-09', () => {
    fc.assert(
      fc.property(
        sourceArb,
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 9 }),
        (source, percents) => {
          const total = totalOf(source)
          const billed: DocumentRate[] = []
          let left = total
          for (const percent of percents) {
            const amount = roundHalfUp(total.times(percent).dividedBy(100), 2)
            if (amount.isZero() || amount.gte(left)) break
            const part = partOfRates(source, billed, plain(amount) as Money, 'AED')
            const gross = part.reduce((acc, r) => acc.plus(toDec(r.gross)), toDec('0'))
            expect(gross.eq(amount)).toBe(true)
            for (const r of part) {
              expect(toDec(r.net).plus(toDec(r.vat)).eq(toDec(r.gross))).toBe(true)
              expect(residual(r).lte('0.011')).toBe(true)
            }
            billed.push(...part)
            left = left.minus(amount)
          }
          const rest = restOfRates(source, billed, 'AED')
          for (const r of rest) expect(residual(r).lte('0.011')).toBe(true)
          const all = [...billed, ...rest]
          for (const r of source) {
            const same = all.filter((x) => x.vatCategory === r.vatCategory)
            const net = same.reduce((acc, x) => acc.plus(toDec(x.net)), toDec('0'))
            const vat = same.reduce((acc, x) => acc.plus(toDec(x.vat)), toDec('0'))
            expect(net.eq(toDec(r.net))).toBe(true)
            expect(vat.eq(toDec(r.vat))).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('deposits: deposit VAT + final VAT = VAT on the work, and the final invoice keeps S-09', () => {
    fc.assert(
      fc.property(
        sourceArb,
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 4 }),
        (work, percents) => {
          const total = totalOf(work)
          const deposits: { id: string; rates: DocumentRate[] }[] = []
          let billed = toDec('0')
          for (const [i, percent] of percents.entries()) {
            const amount = roundHalfUp(total.times(percent).dividedBy(100), 2)
            if (amount.isZero() || billed.plus(amount).gte(total)) break
            const before = deposits.flatMap((d) => d.rates)
            deposits.push({
              id: `d${i}`,
              rates: partOfRates(work, before, plain(amount) as Money, 'AED'),
            })
            billed = billed.plus(amount)
          }
          const final = applyDeductions(work, deductionsOf(deposits), 'AED')
          if (typeof final === 'string') throw new Error(final)
          const depositVat = deposits
            .flatMap((d) => d.rates)
            .reduce((acc, r) => acc.plus(toDec(r.vat)), toDec('0'))
          const workVat = work.reduce((acc, r) => acc.plus(toDec(r.vat)), toDec('0'))
          expect(depositVat.plus(toDec(final.vat)).eq(workVat)).toBe(true)
          for (const r of final.rates) expect(residual(r).lte('0.011')).toBe(true)
          expect(toDec(final.total).plus(billed).eq(total)).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('payments are counted once: the allocations add up to what was paid', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 5_000_000n }), { minLength: 1, maxLength: 6 }),
        (paid, needs) => {
          const available = plain(toDec(paid.toString()).dividedBy(100))
          const alloc = allocatePayments(
            available,
            needs.map((n) => ({ need: plain(toDec(n.toString()).dividedBy(100)) })),
          )
          const sum = alloc.reduce((acc, a) => acc.plus(toDec(a)), toDec('0'))
          expect(sum.eq(toDec(available))).toBe(true)
          alloc.slice(0, -1).forEach((a, i) => {
            expect(toDec(a).lte(toDec(needs[i]!.toString()).dividedBy(100))).toBe(true)
            expect(toDec(a).gte(0)).toBe(true)
          })
        },
      ),
      { numRuns: 300 },
    )
  })
})
