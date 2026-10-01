import type {
  DashboardChecklistDto,
  ProductCostBreakdownDto,
  ProductCostListDto,
} from '@bizcost/contracts'
import { addMonths, monthOf, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { ok, purchaseInput } from './purchasing'
import { WORKSHOP } from './settings'

// The costing and security adversary's proof tests for product costs (M2 Step 6; D-202). Each test
// states what the owner's rule of 2026-09-30 (D-202) or ARCHITECTURE.md §Redaction asks for and
// fails while the build does otherwise.

let api: ProductCostsApi

beforeAll(() => {
  api = new ProductCostsApi()
})

afterAll(async () => {
  await api.close()
})

function bought(materialId: string, qty: string, unitPrice: string) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, unit: 'kg' }
}

/** A workshop with a rent of 3 000 and electricity of 900 a month since 3 months ago. */
async function workshop() {
  const shop = await CostScope.open(api, WORKSHOP)
  const today = await shop.today()
  const lastMonth = addMonths(monthOf(today), -1)
  const categories = await shop.categories()
  const byName = (name: string) => categories.find((c) => c.name === name)!.id
  for (const [name, amount] of [
    ['Rent', '3000'],
    ['Electricity', '900'],
  ] as const) {
    await shop.runningCost({
      id: newId(),
      name,
      categoryId: byName(name),
      amount,
      startsOn: `${addMonths(lastMonth, -2)}-01`,
    })
  }
  const bill = (name: string, amount: string) =>
    shop.expenseDraft(shop.expenseInput(byName(name), today, { amount, periodMonth: lastMonth }))
  const product = await shop.product({ name: `Shelf ${tag()}`, defaultPrice: '40' })
  const monthCosts = async () => (await shop.breakdown(product.id)).monthCosts
  return { shop, today, lastMonth, byName, bill, product, monthCosts }
}

describe('D-202: every running cost and expense counts once', () => {
  it('a category’s bills replace its regular amount, never add to it', async () => {
    // Last month's electricity bill came to 950: that month's electricity is 950, not 900 + 950, and
    // the month's costs are 3 950, not 4 850.
    const { shop, bill, monthCosts } = await workshop()
    await shop.postExpense(await bill('Electricity', '950'))
    const costs = await monthCosts()
    expect(costs.total).toBe('3950')
    expect(costs.categories?.find((c) => c.name === 'Electricity')).toMatchObject({
      source: 'bills',
      amount: '950',
      regular: '900',
    })
  })

  it('a bill finalized by mistake and reversed is as if never posted: the regular amount counts again', async () => {
    const { shop, bill, monthCosts } = await workshop()
    const wrong = await shop.postExpense(await bill('Electricity', '9500'))
    ok(await shop.run('expense.reverse', { id: wrong.id }))
    const costs = await monthCosts()
    expect(costs.total).toBe('3900')
    expect(costs.categories?.find((c) => c.name === 'Electricity')).toMatchObject({
      source: 'regular',
      amount: '900',
    })
  })

  it('only finalized expenses count: a draft, one sent for approval or approved, never does', async () => {
    const { shop, bill, monthCosts } = await workshop()
    await bill('Marketing', '480')
    ok(await shop.run('expense.updateSettings', { approval: true }))
    const sent = await bill('Maintenance', '120')
    ok(await shop.run('expense.submit', { id: sent.id, version: sent.version }))
    const approved = await bill('Marketing', '75')
    const submitted = ok(
      await shop.run<{ data: { version: number } }>('expense.submit', {
        id: approved.id,
        version: approved.version,
      }),
    ).data
    ok(await shop.run('expense.approve', { id: approved.id, version: submitted.version }))
    expect((await monthCosts()).total).toBe('3900')
  })

  it('what was bought never counts in them: materials are each product’s own line', async () => {
    const { shop, lastMonth, monthCosts } = await workshop()
    const wood = await shop.newMaterial({ name: `Wood ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(`${lastMonth}-12`, [bought(wood.id, '1000', '30')]))
    expect((await monthCosts()).total).toBe('3900')
  })

  it('a rent that changes on a day of the month counts once', async () => {
    const { shop, lastMonth, byName, monthCosts } = await workshop()
    // A second rent "paid since" the 1st of last month beside the first one would be counted twice;
    // the first "stopped on" the 1st: only the second counts, for every day.
    const [old] = ok(
      await shop.run<{ data: { items: { id: string; version: number; name: string }[] } }>(
        'runningCost.list',
        { search: 'Rent' },
      ),
    ).data.items
    ok(
      await shop.run('runningCost.update', {
        id: old!.id,
        version: old!.version,
        name: 'Rent',
        categoryId: byName('Rent'),
        amount: '3000',
        startsOn: `${addMonths(lastMonth, -2)}-01`,
        endsOn: `${lastMonth}-01`,
      }),
    )
    await shop.runningCost({
      id: newId(),
      name: 'Rent',
      categoryId: byName('Rent'),
      amount: '3300',
      startsOn: `${lastMonth}-01`,
    })
    expect((await monthCosts()).total).toBe('4200')
  })
})

describe('D-202: awaiting sales is not something the owner can fix', () => {
  it('complete products stay complete, and the Dashboard’s last step is done', async () => {
    const { shop, today } = await workshop()
    const steel = await shop.newMaterial({ name: `Steel ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(steel.id, '10', '12')]))
    for (const name of ['Bench', 'Rack']) {
      const product = await shop.product({ name: `${name} ${tag()}`, defaultPrice: '99' })
      await shop.recipe(product.id, [{ id: newId(), materialId: steel.id, qty: '2', unit: 'kg' }])
    }
    // The workshop's own shelf has no recipe: the only real reason, and the only one counted.
    const page = await shop.costList()
    expect(page.counts.incomplete).toBe(1)
    expect(page.items.every((item) => item.cost.runningCosts.state === 'awaiting_sales')).toBe(true)
    const incomplete = await shop.costList({ filter: 'incomplete' })
    expect(incomplete.items.map((item) => item.cost.reasons)).toEqual([['no_recipe']])
    // Its margin is before running costs, and says so.
    const bench = page.items.find((item) => item.name.startsWith('Bench'))
    expect(bench?.cost).toMatchObject({ complete: true, beforeRunningCosts: true, total: '24' })
    const steps = ok(await shop.run<DashboardChecklistDto>('dashboard.checklist')).costSteps
    expect(steps.find((step) => step.id === 'product_costs')).toMatchObject({ remaining: 1 })
  })
})

describe('ARCHITECTURE.md §Redaction: a hidden value cannot be derived from visible ones', () => {
  it('a member who sees costs but not margins cannot read the margin off the same row', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const oak = await shop.newMaterial({ name: `Oak ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(oak.id, '10', '8.13')]))
    const stool = await shop.product({ name: `Stool ${tag()}`, defaultPrice: '99' })
    await shop.recipe(stool.id, [{ id: newId(), materialId: oak.id, qty: '3', unit: 'kg' }])
    // A Manager whose own override takes margins away (Step 7's overrides UI offers it; a role
    // saved through role.updatePermissions without data.profit_margin.view does the same).
    const person = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, person.user, {
      template: 'manager',
      overrides: [{ key: 'data.profit_margin.view', effect: 'deny' }],
    })
    const owner = await shop.breakdown(stool.id)
    expect(owner.margin.amount).toBe('74.61')

    const one = ok(
      await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', { productId: stool.id }),
    )
    expect(one.meta.redacted).toEqual(expect.arrayContaining(['margin.amount', 'margin.percent']))
    // The page shows it a lock for the margin, and beside it the price before VAT (99) and the cost
    // (24.39): 99 − 24.39 = 74.61, the hidden margin, exactly.
    const { total } = one.data.cost
    const { beforeVat } = one.data.price
    expect(
      typeof total === 'string' && typeof beforeVat === 'string',
      `price before VAT ${String(beforeVat)} − cost ${String(total)} is the hidden margin`,
    ).toBe(false)

    const list = ok(
      await shop.as<ProductCostListDto>(person, 'productCost.list', { search: stool.name }),
    )
    const [row] = list.data.items
    expect(row?.margin.amount).toBeUndefined()
    expect(
      typeof row?.cost.total === 'string' && typeof row.price.beforeVat === 'string',
      'the list row carries the price before VAT and the cost side by side as well',
    ).toBe(false)
  })

  it('a member who sees costs but not expenses cannot read an expense’s amount off the month’s costs', async () => {
    // Expense amounts are supplier prices shown with the expenses (D-165); a category that only has
    // a bill would show that bill's amount.
    const { shop, bill, product } = await workshop()
    await shop.postExpense(await bill('Marketing', '481.37'))
    const person = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, person.user, {
      template: 'accountant',
      overrides: [{ key: 'expenses.documents.view', effect: 'deny' }],
    })
    const result = await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', {
      productId: product.id,
    })
    expect(ok(result).data.monthCosts).toMatchObject({ amountsShown: false, total: null })
    expect(result.raw.includes('481.37')).toBe(false)
    expect(result.raw.includes('4381.37')).toBe(false)
  })
})
