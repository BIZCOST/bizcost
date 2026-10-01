import { describe, expect, it } from 'vitest'
import { addMonths } from '../expenses/period'
import { toDec } from '../numbers/decimal'
import { costPool, type PoolExpense, type PoolRunningCost } from './cost-share'
import { missesOnlyOptionalMaterials, productCost } from './product-cost'

// The costing adversary's proof tests for D-202 (the owner's decision of 2026-09-30): the month's
// costs count every running cost and expense ONCE, and a share awaiting sales is nothing the owner
// can fix. Each test states the owner's rule and fails while the build does otherwise.

const LICENCE = 'cat-licences'
const RENT = 'cat-rent'

const running = (over: Partial<PoolRunningCost> = {}): PoolRunningCost => ({
  categoryId: RENT,
  amount: '12000',
  frequency: 'monthly',
  startsOn: '2026-01-01',
  endsOn: null,
  ...over,
})
const bill = (over: Partial<PoolExpense> = {}): PoolExpense => ({
  categoryId: RENT,
  cost: '12000',
  month: '2026-09',
  reversedIn: null,
  ...over,
})

/** Σ of the month's costs over `count` months from `first`. */
function over(
  first: string,
  count: number,
  costs: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
) {
  let total = toDec('0')
  for (let i = 0; i < count; i += 1) {
    total = total.plus(toDec(costPool(addMonths(first, i), costs, expenses).total))
  }
  return total.toString()
}

describe('D-202: a yearly or quarterly running cost and its bill count once', () => {
  it('a yearly trade licence of 15 000 and its one bill of 15 000 make 15 000 over the year, not 28 750', () => {
    // The demo café's own case: its trade licence is a running cost of 15 000 a year (1 250 a
    // month). In March the owner pays the renewal and enters it as an expense in the same category.
    // March's bill replaces March's 1 250, but the other 11 months still count 1 250 each: the
    // licence is counted 15 000 + 11 × 1 250 = 28 750 over the year, almost twice.
    const licence = running({ categoryId: LICENCE, amount: '15000', frequency: 'yearly' })
    const renewal = bill({ categoryId: LICENCE, cost: '15000', month: '2026-03' })
    expect(over('2026-01', 12, [licence], [renewal])).toBe('15000')
  })

  it('rent of 30 000 a quarter paid by quarterly cheques makes 120 000 over the year, not 200 000', () => {
    // A UAE shop's rent: 30 000 a quarter (10 000 a month), paid by a cheque each quarter, each
    // cheque entered as an expense in the month it is for. Each cheque replaces only its own month's
    // 10 000; the two other months of its quarter still count 10 000 each: 4 × 30 000 + 8 × 10 000 =
    // 200 000 over the year instead of 120 000, and the months with a cheque carry three months' rent.
    const rent = running({ amount: '30000', frequency: 'quarterly' })
    const cheques = ['2026-01', '2026-04', '2026-07', '2026-10'].map((month) =>
      bill({ cost: '30000', month }),
    )
    expect(over('2026-01', 12, [rent], cheques)).toBe('120000')
  })
})

describe('D-202: a reversal counted in a later month takes back only itself', () => {
  it('August’s duplicate rent bill, reversed in September, does not also wipe September’s regular rent', () => {
    // Rent: 12 000 a month. August's rent bill was finalized twice by mistake (24 000 in August,
    // whose books are then closed). In September the duplicate is reversed: it counts back in
    // September (D-200). September has no rent bill of its own, so its rent is its regular 12 000
    // ("a category with running costs and no bills for M uses the regular monthly amount"), less
    // the 12 000 taken back: 0. The build makes the reversal "a bill of September" that replaces the
    // regular amount: September's rent is −12 000, and August + September count 12 000 of rent for
    // two months of rent really paid (24 000).
    const rent = running()
    const august = bill({ month: '2026-08' })
    const duplicate = bill({ month: '2026-08', reversedIn: '2026-09' })
    expect(costPool('2026-08', [rent], [august, duplicate]).total).toBe('24000')
    const september = costPool('2026-09', [rent], [august, duplicate])
    expect(september.total).toBe('0')
    expect(over('2026-08', 2, [rent], [august, duplicate])).toBe('24000')
  })
})

describe('D-202: awaiting sales is not a reason the cost is incomplete', () => {
  it('with a team and without Materials, an item whose only line awaits sales is not "incomplete"', () => {
    // A business with a team (no owner's time, D-119) and Materials off: the only line of an item's
    // cost is its share of the running costs by its price, which awaits sales until Phase 3. Nothing
    // can be added for it, yet the build marks every such item `nothing_counted`: incomplete, in
    // "Needs a look", holding the Dashboard's "See your product costs" back for good.
    const cost = productCost({
      materials: { state: 'off' },
      runningCosts: { state: 'on', costs: '20000', sales: null },
      ownerTime: { state: 'team' },
      sale: {
        price: '400',
        priceIncludesVat: false,
        vatCategory: 'standard',
        vatRegistered: false,
      },
    })
    expect(cost.runningCosts.state).toBe('awaiting_sales')
    expect(cost.beforeRunningCosts).toBe(true)
    expect(cost.reasons).not.toContain('nothing_counted')
    expect(cost.complete).toBe(true)
  })

  it('with a team, a service that uses no materials misses only its optional materials: the Dashboard does not wait for it', () => {
    // Materials on, a team: a consulting service uses no materials (optional for a service, D-186).
    // Its only other line is its share by price, awaiting sales. D-202: awaiting sales "holds no
    // checklist step back", yet missesOnlyOptionalMaterials asks for "something counted" (total not
    // null), which with a team only the awaited share could be: it holds the Dashboard back for good.
    const cost = productCost({
      materials: { state: 'on', perUnit: null, lineCount: 0, unpricedLines: 0, tooLarge: false },
      runningCosts: { state: 'on', costs: '20000', sales: null },
      ownerTime: { state: 'team' },
      sale: {
        price: '400',
        priceIncludesVat: false,
        vatCategory: 'standard',
        vatRegistered: false,
      },
    })
    expect(cost.reasons).toEqual(['no_recipe'])
    expect(missesOnlyOptionalMaterials('service', cost)).toBe(true)
  })
})
