import type { ProductCostBreakdownDto, ProductCostListDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { ok, purchaseInput } from './purchasing'
import { WORKSHOP } from './settings'

// The costing and security adversary's proof tests for product costs (M2 Step 6). Each test states
// what D-116 or ARCHITECTURE.md §Redaction asks for and fails while the build does otherwise.

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

/** A day of the month `offset` months from today's month (YYYY-MM-DD). */
function dayOfMonth(today: string, offset: number, day = 10): string {
  const year = Number.parseInt(today.slice(0, 4), 10)
  const month = Number.parseInt(today.slice(5, 7), 10) - 1 + offset
  const y = year + Math.floor(month / 12)
  const m = ((month % 12) + 12) % 12
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

describe('D-116: the 3 months replace the estimate once 3 months of buying are recorded', () => {
  it('two old invoices typed in on the first day do not replace the estimate with months of almost nothing', async () => {
    // A workshop starts with BizCost today. For their prices, the owner types in two invoices she
    // still has: 1 kg of wood 4 months ago and 1 kg 2 months ago (AED 30 each). Then today's real
    // buying: 1 000 kg at 30. Running costs 15 000 a month; her estimate: 30 000 of materials a month.
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const wood = await shop.newMaterial({ name: `Wood ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(dayOfMonth(today, -4), [bought(wood.id, '1', '30')]))
    await shop.buy(purchaseInput(dayOfMonth(today, -2), [bought(wood.id, '1', '30')]))
    await shop.buy(purchaseInput(today, [bought(wood.id, '1000', '30')]))
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: category!.id,
      amount: '15000',
      startsOn: today,
    })
    const settings = await shop.settings({ estimatedMonthlyPurchases: '30000' })
    // Today the build takes the first purchase's business_date (4 months ago), so the last 3 full
    // months "count": 30 bought in them, 10 a month, and each dirham of materials carries AED 1 500
    // of running costs (a stool of AED 50 of wood would cost 75 050). Nothing was recorded as bought
    // in those months: the business has not had 3 full months of purchases, so its estimate stands.
    expect(settings.rate.purchases).toMatchObject({ source: 'estimate', monthly: '30000' })
    expect(settings.rate.rate).toBe('0.5')
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
})
