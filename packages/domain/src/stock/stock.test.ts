import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { CostAmount, Percent, Quantity } from '../numbers/kinds'
import type { MaterialUnits } from '../units/materials'
import { countDifference, countedBaseQty, openingOf, openingRows, splitLoss } from './count'
import { DEFAULT_USAGE_TOLERANCE } from './keys'
import { absorbingCount, lateOffset, type FinalCount } from './late'
import { stockLevel } from './levels'
import { madeValue, preparedBases, productionUsage, withPreparationLoss } from './production'
import { usagePeriod, type UsagePeriodInput } from './usage'

const q = (value: string) => value as Quantity
const v = (value: string) => value as CostAmount

// Milk kept in ml: 1 carton = 12 bottles, 1 bottle = 1 L (PRODUCT.md §4 rule 8).
const milk: MaterialUnits = {
  dimension: 'volume',
  packs: [
    { id: 'carton', qty: '12', of: { pack: 'bottle' } },
    { id: 'bottle', qty: '1', of: 'l' },
  ],
}

describe('counted lines and first counts', () => {
  it('adds a line typed in several packs: 3 cartons + 4 bottles + 250 ml', () => {
    expect(
      countedBaseQty(
        [
          { qty: q('3'), unit: { pack: 'carton' } },
          { qty: q('4'), unit: { pack: 'bottle' } },
          { qty: q('250'), unit: 'ml' },
        ],
        milk,
      ),
    ).toBe('40250')
  })

  it('refuses a line with no quantity or a part below zero', () => {
    expect(() => countedBaseQty([], milk)).toThrow(RangeError)
    expect(() => countedBaseQty([{ qty: q('-1'), unit: 'ml' }], milk)).toThrow(RangeError)
  })

  it('values a first count at the 90-day average, divided once (40 L at 72 for 12 L = 240)', () => {
    expect(openingOf(q('40000'), { value: '72', qty: '12000' })).toEqual({
      qty: '40000',
      value: '240',
      avgCost: '0.006',
    })
    expect(openingOf(q('3'), { value: '10', qty: '3' })).toEqual({
      qty: '3',
      value: '10',
      avgCost: '3.333333333333',
    })
    expect(openingOf(q('5'), null)).toEqual({ qty: '5', value: '0', avgCost: null })
  })

  it('gives a count’s difference as counted − book', () => {
    expect(countDifference(q('50'), q('130'))).toBe('-80')
    expect(countDifference(q('5'), q('-2'))).toBe('7')
  })
})

describe('a first count in several branches (M4 Step 2)', () => {
  it('splits its value by what each branch counted, the old book on the first line', () => {
    // 25 L in the main branch and 15 L at Marina: 40 L at 6.00 = 240, replacing a book of 216.
    expect(openingRows([q('25000'), q('15000')], v('240'), v('216'))).toEqual([
      { value: '150', adjustment: '216' },
      { value: '90', adjustment: '0' },
    ])
    // Thirds: the shares add up exactly; the last decimal goes to the first line on a tie.
    expect(openingRows([q('1'), q('1'), q('1')], v('10'), v('-4.5'))).toEqual([
      { value: '3.333333333334', adjustment: '-4.5' },
      { value: '3.333333333333', adjustment: '0' },
      { value: '3.333333333333', adjustment: '0' },
    ])
    // A branch that counted nothing takes nothing; nothing counted anywhere is worth nothing.
    expect(openingRows([q('0'), q('12')], v('72'), v('0'))).toEqual([
      { value: '0', adjustment: '0' },
      { value: '72', adjustment: '0' },
    ])
    expect(openingRows([q('0'), q('0')], v('0'), v('30'))).toEqual([
      { value: '0', adjustment: '30' },
      { value: '0', adjustment: '0' },
    ])
  })

  it('refuses no line, a quantity below zero, or a value below zero', () => {
    expect(() => openingRows([], v('0'), v('0'))).toThrow(RangeError)
    expect(() => openingRows([q('-1')], v('0'), v('0'))).toThrow(RangeError)
    expect(() => openingRows([q('1')], v('-1'), v('0'))).toThrow(RangeError)
  })

  it('moves the stock value as wacOpen does: shares add up, none below zero, each at its share', () => {
    const qtyArb = fc
      .integer({ min: 0, max: 10_000_000 })
      .map((n) => toDec(String(n)).dividedBy(1000).toString())
    const valueArb = fc
      .bigInt({ min: 0n, max: 10n ** 20n })
      .map((n) => plain(toDec(n.toString()).dividedBy('1e12')))
    const bookArb = fc
      .bigInt({ min: -(10n ** 18n), max: 10n ** 18n })
      .map((n) => plain(toDec(n.toString()).dividedBy('1e12')))
    fc.assert(
      fc.property(
        fc.array(qtyArb, { minLength: 1, maxLength: 8 }),
        valueArb,
        bookArb,
        (counted, value, book) => {
          const rows = openingRows(counted.map(q), v(value), v(book))
          const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(toDec(x)), toDec('0'))
          expect(sum(rows.map((r) => r.value)).eq(toDec(value))).toBe(true)
          expect(
            sum(rows.map((r) => r.value))
              .minus(sum(rows.map((r) => r.adjustment)))
              .eq(toDec(value).minus(toDec(book))),
          ).toBe(true)
          const total = sum(counted)
          for (const [i, row] of rows.entries()) {
            expect(toDec(row.value).gte(0)).toBe(true)
            expect(toDec(row.value).decimalPlaces()).toBeLessThanOrEqual(12)
            if (total.gt(0)) {
              const exact = toDec(value).times(toDec(counted[i]!)).dividedBy(total)
              expect(toDec(row.value).minus(exact).abs().lt(toDec('0.000000000001'))).toBe(true)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('reasons for a loss', () => {
  it('splits a loss by reasons, the rest unexplained, the values adding up exactly', () => {
    const split = splitLoss(q('3'), v('10'), [
      { reason: 'waste', qty: q('1') },
      { reason: 'staff_use', qty: q('1') },
    ])
    expect(split.parts.map((p) => p.value)).toEqual(['3.333333333333', '3.333333333334'])
    expect(split.unexplained).toEqual({ qty: '1', value: '3.333333333333' })
    const all = splitLoss(q('3'), v('10'), [
      { reason: 'waste', qty: q('1') },
      { reason: 'recipe', qty: q('2') },
    ])
    expect(all.unexplained).toEqual({ qty: '0', value: '0' })
  })

  it('refuses parts beyond the loss, twice the same reason, or an unknown one', () => {
    expect(() => splitLoss(q('1'), v('6'), [{ reason: 'waste', qty: q('2') }])).toThrow(RangeError)
    expect(() =>
      splitLoss(q('2'), v('6'), [
        { reason: 'waste', qty: q('1') },
        { reason: 'waste', qty: q('1') },
      ]),
    ).toThrow(RangeError)
    expect(() => splitLoss(q('2'), v('6'), [{ reason: 'theft' as never, qty: q('1') }])).toThrow(
      RangeError,
    )
    expect(() => splitLoss(q('0'), v('0'), [])).toThrow(RangeError)
  })

  it('never explains more value than the loss, and all of it when it covers all of it', () => {
    const qtyArb = fc
      .integer({ min: 1, max: 1_000_000 })
      .map((n) => toDec(String(n)).dividedBy(1000).toString())
    fc.assert(
      fc.property(
        fc.array(qtyArb, { minLength: 1, maxLength: 6 }),
        fc
          .integer({ min: 0, max: 10_000_000 })
          .map((n) => toDec(String(n)).dividedBy(10_000).toString()),
        fc.boolean(),
        (parts, value, whole) => {
          const reasons = [
            'waste',
            'damaged',
            'staff_use',
            'complimentary',
            'failed',
            'other',
          ] as const
          const sum = parts.reduce((s, p) => s.plus(toDec(p)), toDec('0'))
          const loss = whole ? sum : sum.plus(toDec('0.5'))
          const split = splitLoss(
            q(loss.toString()),
            v(value),
            parts.map((p, i) => ({ reason: reasons[i]!, qty: q(p) })),
          )
          const explained = split.parts.reduce((s, p) => s.plus(toDec(p.value)), toDec('0'))
          expect(explained.plus(toDec(split.unexplained.value)).eq(toDec(value))).toBe(true)
          expect(toDec(split.unexplained.value).gte(0)).toBe(true)
          if (whole) expect(toDec(split.unexplained.value).isZero()).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('usage between two counts', () => {
  const october: UsagePeriodInput = {
    from: '2026-09-30',
    to: '2026-10-31',
    opening: q('40'),
    closing: q('50'),
    inflow: q('600'),
    expected: q('500'),
    expectedValue: v('3000'),
    recordedWaste: q('10'),
    recordedWasteValue: v('60'),
    explained: q('0'),
    explainedValue: v('0'),
    differenceValue: v('-480'),
    tolerance: DEFAULT_USAGE_TOLERANCE,
  }

  it('gives the café’s milk: 18% more than expected, 80 L (AED 480) unexplained', () => {
    expect(usagePeriod(october)).toEqual({
      days: 31,
      actual: '590',
      expected: '500',
      waste: '10',
      unexplained: '80',
      overExpected: '18',
      withinTolerance: false,
      reviewReasons: false,
      wasteValue: { period: '60', perWeek: '13.548387096774', perYear: '706.451612903226' },
      unexplainedValue: {
        period: '480',
        perWeek: '108.387096774194',
        perYear: '5651.612903225806',
      },
    })
  })

  it('calls the café’s beans normal: 2% more, within 5%', () => {
    const beans = usagePeriod({
      ...october,
      opening: q('10'),
      closing: q('9.4'),
      inflow: q('30'),
      expected: q('30'),
      expectedValue: v('2400'),
      recordedWaste: q('0'),
      recordedWasteValue: v('0'),
      differenceValue: v('-48'),
    })
    expect(beans).toMatchObject({
      actual: '30.6',
      unexplained: '0.6',
      overExpected: '2',
      withinTolerance: true,
    })
  })

  it('takes reasons given at the count out of the unexplained usage, into waste', () => {
    const explained = usagePeriod({ ...october, explained: q('30'), explainedValue: v('180') })
    expect(explained).toMatchObject({ waste: '40', unexplained: '50' })
    expect(explained.unexplainedValue.period).toBe('300')
    expect(explained.wasteValue.period).toBe('240')
    expect(explained.reviewReasons).toBe(false)
  })

  it('asks to look at the reasons again when a late entry leaves them explaining more than is missing', () => {
    // 90 L explained of a 100 L loss, then 20 L of sales came in late: 10 L less than expected.
    const late = usagePeriod({
      ...october,
      expected: q('520'),
      recordedWaste: q('0'),
      recordedWasteValue: v('0'),
      closing: q('50'),
      explained: q('90'),
      explainedValue: v('540'),
      differenceValue: v('-480'),
    })
    expect(late).toMatchObject({ waste: '90', unexplained: '-20', reviewReasons: true })
  })

  it('flags any unexplained usage when nothing was expected, and none when nothing is missing', () => {
    const idle = {
      ...october,
      expected: q('0'),
      expectedValue: v('0'),
      recordedWaste: q('0'),
      recordedWasteValue: v('0'),
    }
    expect(usagePeriod({ ...idle, closing: q('640') })).toMatchObject({
      overExpected: null,
      withinTolerance: true,
    })
    expect(usagePeriod({ ...idle, closing: q('639') })).toMatchObject({
      unexplained: '1',
      withinTolerance: false,
    })
  })

  it('refuses a period that does not move forward', () => {
    expect(() => usagePeriod({ ...october, to: '2026-09-30' })).toThrow(RangeError)
    expect(() => usagePeriod({ ...october, tolerance: '-1' as Percent })).toThrow(RangeError)
  })
})

describe('entries posted after a count for a day it covers (Q5)', () => {
  const counts: FinalCount[] = [
    { id: 'sep', day: '2026-09-30' },
    { id: 'oct', day: '2026-10-31' },
  ]

  it('is absorbed by the first count on or after its day', () => {
    expect(absorbingCount('2026-10-31', counts)?.id).toBe('oct')
    expect(absorbingCount('2026-10-05', counts)?.id).toBe('oct')
    expect(absorbingCount('2026-09-12', counts)?.id).toBe('sep')
    expect(absorbingCount('2026-11-01', counts)).toBeNull()
  })

  it('puts a late issue back at its own cost, and offsets anything else at the average', () => {
    expect(lateOffset(q('-20'), v('146.66666666666'))).toEqual({
      kind: 'restock',
      qty: '20',
      value: '146.66666666666',
    })
    expect(lateOffset(q('100'))).toEqual({ kind: 'count', qty: '-100' })
    expect(lateOffset(q('-5'))).toEqual({ kind: 'count', qty: '5' })
    expect(() => lateOffset(q('0'))).toThrow(RangeError)
    expect(() => lateOffset(q('5'), v('10'))).toThrow(RangeError)
    expect(() => lateOffset(q('-5'), v('-10'))).toThrow(RangeError)
  })

  it('keeps every count the truth for its day, whatever the order entries are posted in', () => {
    // One branch's material: counts posted in day order, entries of any day posted in between.
    const dayArb = fc.integer({ min: 1, max: 30 })
    const entryArb = fc.record({
      day: dayArb,
      qty: fc.integer({ min: -50, max: 50 }).filter((n) => n !== 0),
    })
    const planArb = fc.record({
      counts: fc.uniqueArray(
        fc.record({ day: dayArb, counted: fc.integer({ min: 0, max: 200 }) }),
        {
          selector: (c) => c.day,
          minLength: 1,
          maxLength: 4,
        },
      ),
      entries: fc.array(entryArb, { maxLength: 25 }),
      order: fc.array(fc.nat(), { maxLength: 40 }),
    })
    const iso = (day: number) => `2026-10-${String(day).padStart(2, '0')}`
    fc.assert(
      fc.property(planArb, ({ counts: raw, entries, order }) => {
        const plan = [...raw].sort((a, b) => a.day - b.day)
        // Interleave: counts keep their order, entries go anywhere.
        const events: ({ kind: 'count'; i: number } | { kind: 'entry'; i: number })[] = []
        let c = 0
        let e = 0
        for (const o of order) {
          if (o % 2 === 0 && c < plan.length) events.push({ kind: 'count', i: c++ })
          else if (e < entries.length) events.push({ kind: 'entry', i: e++ })
        }
        while (c < plan.length) events.push({ kind: 'count', i: c++ })
        while (e < entries.length) events.push({ kind: 'entry', i: e++ })

        const rows: { day: number; qty: number; count?: number }[] = []
        const finalized: FinalCount[] = []
        for (const event of events) {
          if (event.kind === 'entry') {
            const entry = entries[event.i]!
            rows.push({ day: entry.day, qty: entry.qty })
            const absorbing = absorbingCount(iso(entry.day), finalized)
            if (absorbing) {
              const offset = lateOffset(
                q(String(entry.qty)),
                entry.qty < 0 ? v(String(-entry.qty)) : undefined,
              )
              rows.push({
                day: Number(absorbing.day.slice(8)),
                qty: Number(offset.qty),
                count: Number(absorbing.id),
              })
            }
          } else {
            const count = plan[event.i]!
            const book = rows.filter((r) => r.day <= count.day).reduce((s, r) => s + r.qty, 0)
            rows.push({ day: count.day, qty: count.counted - book, count: event.i })
            finalized.push({ id: String(event.i), day: iso(count.day) })
          }
        }

        const last = plan[plan.length - 1]!
        const after = entries.filter((x) => x.day > last.day).reduce((s, x) => s + x.qty, 0)
        expect(rows.reduce((s, r) => s + r.qty, 0)).toBe(last.counted + after)
        // Each count's whole difference is what it found against the count before and the entries
        // of its period, whenever they were posted.
        plan.forEach((count, k) => {
          const previous = k === 0 ? { day: 0, counted: 0 } : plan[k - 1]!
          const between = entries
            .filter((x) => x.day > previous.day && x.day <= count.day)
            .reduce((s, x) => s + x.qty, 0)
          const absorbed = rows.filter((r) => r.count === k).reduce((s, r) => s + r.qty, 0)
          expect(absorbed).toBe(count.counted - previous.counted - between)
        })
      }),
      { numRuns: 300 },
    )
  })
})

describe('stock levels', () => {
  it('is below zero, low below the level (not at it), or fine', () => {
    expect(stockLevel(q('-3'), null)).toBe('below_zero')
    expect(stockLevel(q('120'), q('200'))).toBe('low')
    expect(stockLevel(q('200'), q('200'))).toBe('ok')
    expect(stockLevel(q('0'), null)).toBe('ok')
  })
})

describe('preparation loss, production and prepared items', () => {
  it('uses more of a line by what is lost in preparation: 200 g with 20% lost is 250 g', () => {
    expect(withPreparationLoss('200', '20' as Percent)).toBe('250')
    expect(withPreparationLoss('100', '15' as Percent)).toBe('117.647059')
    expect(withPreparationLoss('200', null)).toBe('200')
    expect(withPreparationLoss('200', '0' as Percent)).toBe('200')
    expect(() => withPreparationLoss('200', '100' as Percent)).toThrow(RangeError)
    expect(() => withPreparationLoss('200', '-1' as Percent)).toThrow(RangeError)
  })

  it('takes a batch’s materials as the recipe says: 1,000 bottles of a 100-bottle recipe', () => {
    expect(
      productionUsage(q('1000'), {
        yieldQty: '100',
        lines: [
          { materialId: 'base', baseQty: '90000' },
          { materialId: 'bottle', baseQty: '100' },
          { materialId: 'cap', baseQty: '100' },
        ],
      }),
    ).toEqual([
      { materialId: 'base', baseQty: '900000' },
      { materialId: 'bottle', baseQty: '1000' },
      { materialId: 'cap', baseQty: '1000' },
    ])
    expect(() => productionUsage(q('0'), { yieldQty: '1', lines: [] })).toThrow(RangeError)
  })

  it('values the items made at exactly what their materials cost, saying when one had no price', () => {
    expect(madeValue([v('1800'), v('350.5'), v('120.000000000001')])).toEqual({
      value: '2270.500000000001',
      complete: true,
    })
    expect(madeValue([v('10'), null])).toEqual({ value: '10', complete: false })
  })

  it('costs a prepared item from its recipe, nested, and refuses loops and nesting too deep', () => {
    // Vanilla syrup: 1 kg sugar (AED 4/kg) + 50 ml vanilla (AED 0.2/ml) makes 1,000 ml.
    const bases = new Map([
      ['sugar', { value: '4', qty: '1000' }],
      ['vanilla', { value: '0.2', qty: '1' }],
    ])
    const syrup = {
      materialId: 'syrup',
      yieldBaseQty: '1000',
      lines: [
        { materialId: 'sugar', baseQty: '1000' },
        { materialId: 'vanilla', baseQty: '50' },
      ],
    }
    // A topping made with 200 ml of the syrup and 100 g of sugar makes 300 g.
    const topping = {
      materialId: 'topping',
      yieldBaseQty: '300',
      lines: [
        { materialId: 'syrup', baseQty: '200' },
        { materialId: 'sugar', baseQty: '100' },
      ],
    }
    const { bases: out, problems } = preparedBases([topping, syrup], bases)
    expect(out.get('syrup')).toEqual({ value: '14', qty: '1000' })
    expect(out.get('topping')).toEqual({ value: '3.2', qty: '300' })
    expect(problems).toEqual([])

    const unpriced = preparedBases([syrup], new Map([['sugar', { value: '4', qty: '1000' }]]))
    expect(unpriced.bases.get('syrup')).toBeNull()

    const a = { materialId: 'a', yieldBaseQty: '1', lines: [{ materialId: 'b', baseQty: '1' }] }
    const b = { materialId: 'b', yieldBaseQty: '1', lines: [{ materialId: 'a', baseQty: '1' }] }
    const looped = preparedBases([a, b], bases)
    expect(looped.bases.get('a')).toBeNull()
    expect(looped.problems.map((p) => p.problem)).toEqual(['loop', 'loop'])

    const chain = ['d1', 'd2', 'd3', 'd4'].map((id, i, all) => ({
      materialId: id,
      yieldBaseQty: '1',
      lines: [{ materialId: all[i + 1] ?? 'sugar', baseQty: '1' }],
    }))
    const deep = preparedBases(chain, bases)
    expect(deep.problems).toEqual([{ materialId: 'd1', problem: 'too_deep' }])
    expect(deep.bases.get('d1')).toBeNull()
    expect(deep.bases.get('d2')).toEqual({ value: '0.004', qty: '1' })
  })
})
