import type { CostStepDto, DashboardChecklistDto } from '@bizcost/contracts'
import { addMonths, firstDayOf, monthOf, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { ok } from './purchasing'
import { WORKSHOP } from './settings'

// The costing adversary's proof tests for D-202 through the API (the owner's decision of
// 2026-09-30): the month's costs count everything once, and a share awaiting sales is nothing the
// owner can fix. Each test states the rule and fails while the build does otherwise.

let api: ProductCostsApi

beforeAll(() => {
  api = new ProductCostsApi()
})

afterAll(async () => {
  await api.close()
})

/** The day before `day` (YYYY-MM-DD). */
function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

const steps = async (scope: CostScope): Promise<Record<string, Omit<CostStepDto, 'id'>>> =>
  Object.fromEntries(
    ok(await scope.run<DashboardChecklistDto>('dashboard.checklist')).costSteps.map(
      ({ id, ...rest }) => [id, rest],
    ),
  )

describe('D-202: a reversal counted in a later month takes back only itself', () => {
  it('the month before last’s duplicate rent bill, reversed once that month is closed, leaves last month’s regular rent counted', async () => {
    // A workshop's rent: 3 000 a month. The month before last's rent bill was finalized twice by
    // mistake; that month's books are closed; the duplicate is reversed and counts back in last
    // month (D-200). Last month has no rent bill of its own, so its rent is its regular 3 000 less
    // the 3 000 taken back: 0. The build shows last month's rent as −3 000 "from its bills, in place
    // of its regular 3 000": the reversal takes itself back AND last month's rent.
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const lastMonth = addMonths(monthOf(today), -1)
    const monthBefore = addMonths(lastMonth, -1)
    const rent = (await shop.categories()).find((c) => c.name === 'Rent')!.id
    await shop.runningCost({
      id: newId(),
      name: `Rent ${tag()}`,
      categoryId: rent,
      amount: '3000',
      startsOn: `${addMonths(lastMonth, -3)}-01`,
    })
    const bill = async () =>
      shop.postExpense(
        await shop.expenseDraft(
          shop.expenseInput(rent, today, { amount: '3000', periodMonth: monthBefore }),
        ),
      )
    await bill()
    const duplicate = await bill()
    ok(await shop.run('books.close', { closedThrough: dayBefore(firstDayOf(lastMonth)) }))
    ok(await shop.run('expense.reverse', { id: duplicate.id }))

    const costs = (await shop.costList()).monthCosts
    expect(costs.month).toBe(lastMonth)
    expect(costs.categories?.find((c) => c.categoryId === rent)?.amount).toBe('0')
    expect(costs.total).toBe('0')
  })
})

describe('D-202: awaiting sales holds nothing back', () => {
  it('a business with a team that sells only services: its priced services are not "incomplete" and "See your product costs" is done', async () => {
    // A small agency: services only, a team (no owner's time, D-119), no materials. Each service's
    // cost is only its share of the running costs by its price, which awaits sales until Phase 3:
    // nothing can be added for it. The build marks every service `nothing_counted`, counts them in
    // "Needs a look" and never lets the Dashboard's last step be done.
    const agency = await CostScope.open(api, {
      what_you_do: ['services'],
      workplace: 'office',
      branches: false,
      team: 'team',
      team_tracking: ['salaries'],
      work_setup: ['none'],
      sales_channels: ['quotes'],
      vat: 'no',
    })
    const today = await agency.today()
    await agency.product({ name: `Brand workshop ${tag()}`, type: 'service', defaultPrice: '4000' })
    const [category] = await agency.categories()
    await agency.runningCost({
      id: newId(),
      name: `Office ${tag()}`,
      categoryId: category!.id,
      amount: '9000',
      startsOn: today,
    })
    const page = await agency.costList()
    expect(page.items[0]?.cost.runningCosts.state).toBe('awaiting_sales')
    expect(page.items[0]?.cost.reasons).toEqual([])
    expect(page.counts.incomplete).toBe(0)
    expect((await steps(agency)).product_costs).toMatchObject({ done: true, remaining: 0 })
  })
})
