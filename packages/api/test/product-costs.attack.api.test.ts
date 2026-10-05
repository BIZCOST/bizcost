import type { ProductCostListDto, ProductCostsDto, ProductDto } from '@bizcost/contracts'
import { addMonths, monthOf, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { codeOf, ok, purchaseInput, type Person } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// Attacks on product costs (M2 Step 6): pages that are not the server's, values at the columns'
// limits, members whose own overrides take away what seeing product costs needs, a member who may
// see costs but not supplier prices (who sees neither, D-144), and the owner's time of a business
// that takes on a team (hidden and kept, D-119).

let api: ProductCostsApi

beforeAll(() => {
  api = new ProductCostsApi()
})

afterAll(async () => {
  await api.close()
})

function bought(materialId: string, qty: string, unitPrice: string, unit: string) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, unit }
}

describe('pages and cursors', () => {
  let shop: CostScope
  const prefix = `Paged ${tag()}`

  beforeAll(async () => {
    shop = await CostScope.open(api, WORKSHOP)
    for (const key of ['A', 'B', 'C']) {
      await shop.product({ name: `${prefix} ${key}`, defaultPrice: key === 'B' ? '5' : '10' })
    }
  }, 60_000)

  const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  it('a cursor the server did not make, or made for another order, is VALIDATION', async () => {
    for (const bad of [
      cursor(['productCost', 'name', 'asc', null, -1]),
      cursor(['productCost', 'name', 'asc', null, 1.5]),
      cursor(['productCost', 'name', 'asc', null, '1']),
      cursor(['productCost', 'name', 'desc', null, 1]),
      cursor(['productCost', 'name', 'asc', 'loss', 1]),
      cursor(['material', 'name', 'asc', null, 1]),
      cursor({ offset: 1 }),
      '%%%',
    ]) {
      expect(codeOf(await shop.run('productCost.list', { search: prefix, cursor: bad })), bad).toBe(
        'validation',
      )
    }
  })

  it('a cursor past the end is an empty last page, by name or by price', async () => {
    for (const sort of ['name', 'price']) {
      const page = await shop.costList({
        search: prefix,
        sort,
        cursor: cursor(['productCost', sort, 'asc', null, 99]),
      })
      expect(page.items).toEqual([])
      expect(page.nextCursor).toBeNull()
    }
  })

  it('by name the database pages it; by price every product is costed, then paged', async () => {
    const byName = await shop.costList({ search: prefix, limit: 2 })
    expect(byName.items.map((i) => i.name)).toEqual([`${prefix} A`, `${prefix} B`])
    const rest = await shop.costList({ search: prefix, limit: 2, cursor: byName.nextCursor })
    expect(rest.items.map((i) => i.name)).toEqual([`${prefix} C`])
    expect(rest.nextCursor).toBeNull()
    const byPrice = await shop.costList({ search: prefix, sort: 'price', order: 'desc' })
    expect(byPrice.items.map((i) => i.name)).toEqual([`${prefix} A`, `${prefix} C`, `${prefix} B`])
  })
})

describe('values at the columns’ limits are never an internal error', () => {
  it('the month’s costs at the columns’ widest amounts are summed exactly, never INTERNAL', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const lastMonth = addMonths(monthOf(today), -1)
    const steel = await shop.newMaterial({ name: `Steel ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(steel.id, '1', '3', 'kg')]))
    const beam = await shop.product({ name: `Beam ${tag()}`, defaultPrice: '9999999999999999' })
    await shop.recipe(beam.id, [{ id: newId(), materialId: steel.id, qty: '1', unit: 'kg' }])
    const categories = await shop.categories()
    const byName = (name: string) => categories.find((c) => c.name === name)!.id
    // Two of the widest running costs, each paid weekly since 2 months ago, and the widest bill.
    for (const name of ['Rent', 'Salaries']) {
      await shop.runningCost({
        id: newId(),
        name,
        categoryId: byName(name),
        amount: '9999999999999999',
        frequency: 'weekly',
        startsOn: `${addMonths(lastMonth, -1)}-01`,
      })
    }
    await shop.postExpense(
      await shop.expenseDraft(
        shop.expenseInput(byName('Marketing'), today, {
          amount: '9999999999999999',
          vatRate: '0',
          periodMonth: lastMonth,
        }),
      ),
    )
    const cost = await shop.breakdown(beam.id)
    // 9 999 999 999 999 999 × 52 ÷ 12 = 43 333 333 333 333 329 a month, twice, and the bill.
    expect(cost.monthCosts).toMatchObject({
      state: 'awaiting_sales',
      total: '96666666666666657',
    })
    expect(cost.monthCosts.categories?.map((c) => c.amount)).toEqual([
      '43333333333333329',
      '43333333333333329',
      '9999999999999999',
    ])
    expect(cost.cost).toMatchObject({
      materials: '3',
      runningCosts: { state: 'awaiting_sales', amount: null },
      total: '3',
      tooLarge: false,
    })
    const list = await shop.costList({ search: beam.name, sort: 'margin' })
    expect(list.items[0]?.margin.amount).toBe('9999999999999996')
  })

  it('the widest hourly rate is stored exactly', async () => {
    const baker = await CostScope.open(api, BAKER)
    const settings = await baker.settings({ ownerHourlyRate: '9999999999999999.99' })
    expect(settings).toMatchObject({ ownerHourlyRate: '9999999999999999.99' })
    // One more digit does not fit numeric(20,4): VALIDATION, before anything is written.
    expect(
      codeOf(
        await baker.run('productCost.updateSettings', { ownerHourlyRate: '99999999999999999' }),
      ),
    ).toBe('validation')
  })
})

describe('what seeing product costs needs, checked on every call', () => {
  let shop: CostScope
  let stool: ProductDto

  beforeAll(async () => {
    shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const oak = await shop.newMaterial({ name: `Oak ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(oak.id, '10', '8.13', 'kg')]))
    stool = await shop.product({ name: `Stool ${tag()}`, defaultPrice: '99' })
    await shop.recipe(stool.id, [{ id: newId(), materialId: oak.id, qty: '3', unit: 'kg' }])
  }, 60_000)

  async function managerWithout(key: string): Promise<Person> {
    const person = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, person.user, {
      template: 'manager',
      overrides: [{ key, effect: 'deny' }],
    })
    return person
  }

  it('a Manager whose own override takes away recipes or materials: FORBIDDEN, with nothing', async () => {
    for (const key of ['products.recipes.view', 'materials.items.view', 'products.items.view']) {
      const person = await managerWithout(key)
      for (const [path, input] of [
        ['productCost.list', {}],
        ['productCost.get', { productId: stool.id }],
      ] as const) {
        const result = await shop.as(person, path, input)
        expect(codeOf(result), `${key} ${path}`).toBe('forbidden')
        expect(result.raw.includes('24.39')).toBe(false)
        expect(result.raw.includes(stool.name)).toBe(false)
      }
    }
  })

  it('a Manager whose override takes away supplier prices sees no costs either (D-144)', async () => {
    const person = await managerWithout('data.supplier_price.view')
    const list = ok(await shop.as<ProductCostListDto>(person, 'productCost.list', {}))
    expect(list.meta.redacted).toEqual(
      expect.arrayContaining(['items.*.cost.total', 'items.*.margin.percent', 'monthCosts.total']),
    )
    expect(JSON.stringify(list.data).includes('24.39')).toBe(false)
    expect(codeOf(await shop.as(person, 'productCost.list', { sort: 'cost' }))).toBe('forbidden')
    expect(
      codeOf(await shop.as(person, 'productCost.updateSettings', { ownerHourlyRate: '100' })),
    ).toBe('forbidden')
    // It still sees its own view of the page by name and by price.
    ok(await shop.as(person, 'productCost.list', { sort: 'price' }))
  })

  it('the owner sees the stool: 3 kg of oak at 8.13 = 24.39', async () => {
    expect((await shop.breakdown(stool.id)).cost.materials).toBe('24.39')
  })
})

describe('a business that takes on a team: the owner’s time is hidden and kept (D-119)', () => {
  it('hidden with a team, back as it was without one', async () => {
    const baker = await CostScope.open(api, BAKER)
    const today = await baker.today()
    const flour = await baker.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    await baker.buy(purchaseInput(today, [bought(flour.id, '1', '4', 'kg')]))
    const loaf = await baker.product({
      name: `Loaf ${tag()}`,
      defaultPrice: '20',
      ownerMinutes: '30',
    })
    await baker.recipe(loaf.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
    await baker.settings({ ownerHourlyRate: '40' })
    expect((await baker.breakdown(loaf.id)).cost).toMatchObject({
      materials: '2',
      ownerTime: { state: 'applied', minutes: '30', amount: '20' },
      total: '22',
    })

    const team = (enabled: boolean) =>
      baker.run('business.customize', { item: { kind: 'capability', key: 'has_team' }, enabled })
    ok(await team(true))
    const withTeam = await baker.breakdown(loaf.id)
    expect(withTeam.ownerTime).toEqual({ applies: false, hourlyRate: '40' })
    expect(withTeam.cost).toMatchObject({
      ownerTime: { state: 'team', minutes: null, amount: null },
      total: '2',
    })
    const [forForm] = ok(await baker.run<ProductCostsDto>('product.costs', { ids: [loaf.id] })).data
      .items
    expect(forForm?.ownerMinutes).toBeNull()
    // Kept, and not changed from a form that no longer shows them.
    const [row] = await api.admin<{ owner_minutes: string }[]>`
      select trim_scale(owner_minutes)::text as owner_minutes
        from app.products_services where id = ${loaf.id}`
    expect(row?.owner_minutes).toBe('30')
    expect(
      codeOf(
        await baker.run('product.update', {
          id: loaf.id,
          version: loaf.version,
          name: loaf.name,
          type: 'product',
          unit: 'piece',
          defaultPrice: '20',
          ownerMinutes: null,
        }),
      ),
    ).toBe('capability_disabled')
    expect(codeOf(await baker.run('productCost.updateSettings', { ownerHourlyRate: '50' }))).toBe(
      'capability_disabled',
    )

    ok(await team(false))
    expect((await baker.breakdown(loaf.id)).cost).toMatchObject({
      ownerTime: { state: 'applied', minutes: '30', amount: '20' },
    })
  })
})
