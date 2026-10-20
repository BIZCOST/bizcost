import { compareDecimal, subtractDecimals, sumDecimals } from '@bizcost/domain'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ownCharges, type EntryRecord } from './statement-charges'

// A customer's statement entries, day by day (D-313): a past day's entries never change whatever
// comes after, so a statement of last month made today is the one made last month, and each period
// starts where the one before ended; what is owed after the entries is What customers owe's figure.

const ORDER = 'order-1'
const SALE = 'sale-1'
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`

let seq = 0
function entry(input: Partial<EntryRecord> & Pick<EntryRecord, 'kind' | 'date'>): EntryRecord {
  seq += 1
  return {
    id: `${input.kind}-${seq}`,
    number: null,
    reference: null,
    charge: '0',
    credit: '0',
    paid_when_made: false,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    item_names: [],
    method: null,
    src_kind: null,
    src_id: null,
    src_number: null,
    bills_less: false,
    ...input,
  }
}
const delivered = (date: string, payable: string) =>
  entry({
    kind: 'order',
    date,
    charge: payable,
    src_kind: 'order',
    src_id: ORDER,
    src_number: '#1011',
  })
const orderInvoice = (date: string, payable: string, id?: string) =>
  entry({
    kind: 'invoice',
    date,
    charge: payable,
    src_kind: 'order',
    src_id: ORDER,
    src_number: '#1011',
    ...(id ? { id } : {}),
  })
const orderNote = (date: string, total: string, billsLess: boolean) =>
  entry({
    kind: 'credit_note',
    date,
    credit: total,
    src_kind: 'order',
    src_id: ORDER,
    src_number: '#1011',
    bills_less: billsLess,
  })
const timeOf = (row: EntryRecord) => new Date(row.created_at).getTime()
const byDay = (rows: EntryRecord[]) =>
  [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : timeOf(a) - timeOf(b)))
const shown = (rows: EntryRecord[]) =>
  ownCharges(byDay(rows)).map((r) => ({
    kind: r.kind,
    date: r.date,
    charge: r.charge,
    credit: r.credit,
    owedThrough: r.owedThrough,
  }))
const owedOf = (rows: readonly { charge: string; credit: string }[]) =>
  subtractDecimals(sumDecimals(rows.map((r) => r.charge)), sumDecimals(rows.map((r) => r.credit)))

describe('ownCharges: each entry as it stood at the end of its day', () => {
  it('an order delivered on the 1st, then its deposit, the deposit credited and its final invoice on later days', () => {
    const rows = [
      delivered(day(1), '10500'),
      orderInvoice(day(5), '3150'),
      orderNote(day(6), '3150', true),
      orderInvoice(day(7), '10500'),
    ]
    expect(shown(rows)).toEqual([
      { kind: 'order', date: day(1), charge: '10500', credit: '0', owedThrough: null },
      {
        kind: 'invoice',
        date: day(5),
        charge: '0',
        credit: '0',
        owedThrough: { amount: '3150', orderNumber: '#1011' },
      },
      {
        kind: 'credit_note',
        date: day(6),
        charge: '0',
        credit: '0',
        owedThrough: { amount: '3150', orderNumber: '#1011' },
      },
      {
        kind: 'invoice',
        date: day(7),
        charge: '0',
        credit: '0',
        owedThrough: { amount: '10500', orderNumber: '#1011' },
      },
    ])
  })

  it('an order delivered and invoiced on one day is listed through its invoices only', () => {
    // A deposit invoice while it waits, then the delivery and the final invoice on the 3rd.
    const rows = [
      orderInvoice(day(1), '3150'),
      delivered(day(3), '10500'),
      orderInvoice(day(3), '7350'),
    ]
    expect(shown(rows)).toEqual([
      { kind: 'invoice', date: day(1), charge: '3150', credit: '0', owedThrough: null },
      { kind: 'invoice', date: day(3), charge: '7350', credit: '0', owedThrough: null },
    ])
  })

  it('a delivery on the 3rd after a deposit invoice: charges the rest; the final invoice later charges nothing again', () => {
    const rows = [
      orderInvoice(day(1), '3150'),
      delivered(day(3), '10500'),
      orderInvoice(day(9), '7350'),
    ]
    const out = shown(rows)
    expect(out.map((r) => [r.kind, r.charge])).toEqual([
      ['invoice', '3150'],
      ['order', '7350'],
      ['invoice', '0'],
    ])
    expect(owedOf(out)).toBe('10500')
  })

  it("a sale they'll pay later invoiced on a later day, and one invoiced on its own day", () => {
    const later = [
      entry({ kind: 'sale', date: day(2), charge: '2100', src_kind: 'sale', src_id: SALE }),
      entry({ kind: 'invoice', date: day(4), charge: '2100', src_kind: 'sale', src_id: SALE }),
    ]
    expect(shown(later).map((r) => [r.kind, r.charge, r.owedThrough])).toEqual([
      ['sale', '2100', null],
      ['invoice', '0', { amount: '2100', orderNumber: null }],
    ])
    const sameDay = [
      entry({ kind: 'sale', date: day(2), charge: '2100', src_kind: 'sale', src_id: SALE }),
      entry({ kind: 'invoice', date: day(2), charge: '2100', src_kind: 'sale', src_id: SALE }),
    ]
    expect(shown(sameDay).map((r) => [r.kind, r.charge])).toEqual([['invoice', '2100']])
  })

  it('an invoice of a sale that rounds its total down takes the difference off on its day', () => {
    const rows = [
      entry({ kind: 'sale', date: day(2), charge: '2100.25', src_kind: 'sale', src_id: SALE }),
      entry({ kind: 'invoice', date: day(4), charge: '2100', src_kind: 'sale', src_id: SALE }),
    ]
    const out = shown(rows)
    expect(out[1]).toMatchObject({ charge: '-0.25' })
    expect(owedOf(out)).toBe('2100')
  })

  it('leaves entries of no order or sale as they are', () => {
    const payment = entry({ kind: 'payment', date: day(2), credit: '500' })
    const quoted = entry({ kind: 'invoice', date: day(2), charge: '800' })
    expect(shown([payment, quoted]).map((r) => [r.kind, r.charge, r.credit])).toEqual([
      ['payment', '0', '500'],
      ['invoice', '800', '0'],
    ])
  })
})

// Random histories of one order: its delivery (or none), invoices and credit notes on days 1–10.
const history = fc
  .record({
    base: fc.integer({ min: 100, max: 20_000 }),
    deliveredOn: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
    deliveryAt: fc.integer({ min: 0, max: 6 }),
    invoices: fc.array(
      fc.record({ on: fc.integer({ min: 1, max: 10 }), share: fc.integer({ min: 1, max: 60 }) }),
      { maxLength: 4 },
    ),
    notes: fc.array(
      fc.record({
        of: fc.nat(),
        after: fc.integer({ min: 0, max: 4 }),
        share: fc.integer({ min: 1, max: 100 }),
        billsLess: fc.boolean(),
      }),
      { maxLength: 3 },
    ),
  })
  .map((h) => {
    seq = 0
    const rows: EntryRecord[] = []
    const facts: { on: number; payable: number; credited: number; billsLessCredited: number }[] = []
    h.invoices.forEach((inv, index) => {
      if (h.deliveredOn !== null && index === h.deliveryAt)
        rows.push(delivered(day(h.deliveredOn), String(h.base)))
      const payable = Math.max(1, Math.floor((h.base * inv.share) / 100))
      rows.push(orderInvoice(day(inv.on), String(payable)))
      facts.push({ on: inv.on, payable, credited: 0, billsLessCredited: 0 })
    })
    if (h.deliveredOn !== null && h.deliveryAt >= h.invoices.length) {
      rows.push(delivered(day(h.deliveredOn), String(h.base)))
    }
    const notes: { on: number; total: number; billsLess: boolean }[] = []
    for (const note of h.notes) {
      if (facts.length === 0) break
      const fact = facts[note.of % facts.length]!
      const left = fact.payable - fact.credited
      if (left <= 0) continue
      const total = Math.max(1, Math.floor((left * note.share) / 100))
      const on = Math.min(10, fact.on + note.after)
      fact.credited += total
      rows.push(orderNote(day(on), String(total), note.billsLess))
      notes.push({ on, total, billsLess: note.billsLess })
    }
    // What customers owe after day `cut` (receivables.ts): the invoices less their credit notes, and a
    // delivered order's rest its invoices do not bill.
    const owedAfter = (cut: number) => {
      const payable = facts.filter((f) => f.on <= cut).reduce((sum, f) => sum + f.payable, 0)
      const credited = notes.filter((n) => n.on <= cut).reduce((sum, n) => sum + n.total, 0)
      const billsLess = notes
        .filter((n) => n.on <= cut && n.billsLess)
        .reduce((sum, n) => sum + n.total, 0)
      const rest =
        h.deliveredOn !== null && h.deliveredOn <= cut
          ? Math.max(0, h.base - (payable - billsLess))
          : 0
      return String(payable - credited + rest)
    }
    return { rows: byDay(rows), owedAfter }
  })

describe('ownCharges: a past day never changes (property)', () => {
  it('the entries up to any day are the same whatever comes after it, and add up to what is owed then', () => {
    fc.assert(
      fc.property(history, ({ rows, owedAfter }) => {
        const all = ownCharges(rows)
        for (let cut = 0; cut <= 10; cut++) {
          const upTo = rows.filter((r) => r.date <= day(cut))
          const then = ownCharges(upTo)
          const fromAll = all.filter((r) => r.date <= day(cut))
          expect(then).toEqual(fromAll)
          expect(compareDecimal(owedOf(then), owedAfter(cut))).toBe(0)
        }
        for (const r of all) {
          expect(compareDecimal(r.charge, '0')).toBeGreaterThanOrEqual(0)
          expect(compareDecimal(r.credit, '0')).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: 400 },
    )
  })
})
