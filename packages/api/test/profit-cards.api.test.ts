import { addMonths, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { dayOf, ProfitApi, ProfitScope, type Cards } from './profit'
import { purchaseInput, type Person } from './purchasing'
import { bought, CAFE, item, shift } from './sales'

// The Dashboard's decision cards (ROADMAP.md M3 Step 3; PRODUCT.md §9; Q14 of D-218): only the cards
// the business has data for and the member may see. The owner sees real profit against last month,
// sales against last month, where the money went, sales and profit by day, top products by quantity
// and margin, a product sold at a loss, a cost increase of 10 % or more in 30 days, sales by channel
// (two channels), and what needs a look; the Sales template sees the sales cards without any profit
// or cost fact; the Employee sees none; a business without sales has none.

let api: ProfitApi
let cafe: ProfitScope
let today: string
let month: string
let last: string
let sales: Person & { memberId: string }
let employee: Person & { memberId: string }
let accountant: Person & { memberId: string }
const names = {} as Record<'latte' | 'cheap' | 'bare' | 'beans' | 'gypsum' | 'unpriced', string>
let talabatName: string

beforeAll(async () => {
  api = new ProfitApi()
  cafe = await ProfitScope.open(api, CAFE)
  ;({ today, month, last } = await cafe.months())
  sales = await api.member(cafe, 'sales')
  employee = await api.member(cafe, 'employee')
  accountant = await api.member(cafe, 'accountant')
  await cafe.monthly('3000', dayOf(addMonths(last, -2), 1))
  // Beans: 10.00 a kg 40 days ago, 15.00 today: the 90-day average rose from 10 to 12.50 (+25 %).
  const beans = await cafe.newMaterial({ name: `Beans ${tag()}`, unit: 'piece' })
  names.beans = beans.name
  await cafe.buy(
    purchaseInput(shift(today, -40), [bought(beans.id, '100', '10', { unit: 'piece' })]),
  )
  await cafe.buy(purchaseInput(today, [bought(beans.id, '100', '15', { unit: 'piece' })]))
  const latte = await cafe.madeOf(beans, '30')
  names.latte = latte.name
  // Sold below what it costs: a loss.
  const cheap = await cafe.madeOf(beans, '5')
  names.cheap = cheap.name
  // A product with no recipe; a material in it never bought.
  const bare = await cafe.product({ name: `Bare ${tag()}`, defaultPrice: '20' })
  names.bare = bare.name
  const unpriced = await cafe.newMaterial({ name: `Saffron ${tag()}`, unit: 'piece' })
  names.unpriced = unpriced.name
  const fancy = await cafe.product({ name: `Fancy ${tag()}`, defaultPrice: '40' })
  await cafe.recipe(fancy.id, [{ id: newId(), materialId: unpriced.id, qty: '1', unit: 'piece' }])
  // Gypsum bought this month, in no recipe.
  const gypsum = await cafe.pieceMaterial('Gypsum', '7', today, '3')
  names.gypsum = gypsum.name
  const talabat = await cafe.deliveryApp(null)
  talabatName = talabat.name
  const shop = await cafe.channelId()
  await cafe.sell({
    businessDate: dayOf(last, 5),
    channelId: shop,
    lines: [item(latte.id, '100', '30')],
  })
  await cafe.sell({
    businessDate: dayOf(month, 1),
    channelId: shop,
    lines: [
      item(latte.id, '50', '30'),
      item(cheap.id, '10', '5'),
      item(bare.id, '2', '20'),
      item(fancy.id, '1', '40'),
    ],
  })
  await cafe.sell({
    businessDate: today,
    channelId: talabat.id,
    lines: [item(latte.id, '5', '30')],
  })
}, 180_000)

afterAll(async () => {
  await api.close()
})

describe('the owner sees every card the business has data for', () => {
  let cards: Cards

  beforeAll(async () => {
    cards = await cafe.cards()
  })

  it('real profit and sales this month against last month', () => {
    expect(cards).toMatchObject({ month, lastMonth: last, profitShown: true })
    expect(cards.sales).toEqual({
      from: dayOf(month, 1),
      to: today,
      value: '1780',
      lastMonth: '3000',
    })
    expect(cards.profit).toMatchObject({ from: dayOf(month, 1), to: today, complete: false })
    expect(cards.profit?.profit).not.toBeNull()
    expect(cards.profit?.lastMonthProfit).not.toBeNull()
  })

  it('where the money went: the month’s costs so far in place of the shares', () => {
    expect(cards.moneyWent).toMatchObject({ sales: '1780' })
    expect(cards.moneyWent?.runningCosts).not.toBeNull()
  })

  it('sales and real profit by day: every day of the month so far', () => {
    const days = cards.byDay?.days ?? []
    const first = today === dayOf(month, 1)
    expect(days[0]).toMatchObject({ day: dayOf(month, 1), sales: first ? '1780' : '1630' })
    expect(days.at(-1)).toMatchObject({ day: today, sales: first ? '1780' : '150' })
    expect(days).toHaveLength(Number(today.slice(8, 10)))
  })

  it('top products by quantity, and by real margin among complete costs', () => {
    expect(cards.topProducts?.byQuantity[0]).toMatchObject({ name: names.latte, quantity: '55' })
    const byMargin = cards.topProducts?.byMargin ?? []
    expect(byMargin.map((p) => p.name)).not.toContain(names.bare)
  })

  it('a loss or a low margin, and a cost that rose 10 % or more in 30 days', () => {
    expect(cards.concerns?.map((c) => [c.name, c.concern])).toContainEqual([names.cheap, 'loss'])
    expect(cards.costIncreases).toEqual([
      expect.objectContaining({ name: names.beans, before: '10', now: '12.5', percent: '25' }),
    ])
  })

  it('sales by channel (two channels sold)', () => {
    expect(cards.byChannel?.map((c) => [c.name, c.sales])).toEqual([
      [expect.any(String), '1630'],
      [talabatName, '150'],
    ])
  })

  it('what needs a look: a material with no price, a channel without fees, a product without a recipe, a material in no recipe', () => {
    expect(cards.needsLook).toEqual({
      unpricedMaterials: [{ id: expect.any(String), name: names.unpriced }],
      channelsWithoutFees: [{ id: expect.any(String), name: talabatName }],
      productsWithoutRecipe: [{ id: expect.any(String), name: names.bare }],
      materialsInNoRecipe: [{ id: expect.any(String), name: names.gypsum }],
    })
  })

  it('the Accountant sees them too', async () => {
    const theirs = await cafe.cards(accountant)
    expect(theirs.profitShown).toBe(true)
    expect(theirs.needsLook).toEqual(cards.needsLook)
  })
})

describe('who sees which card', () => {
  it('the Sales template: sales, by day, top products and channels, never a profit or cost fact', async () => {
    const theirs = await cafe.cards(sales)
    expect(theirs.profitShown).toBe(false)
    expect(theirs.sales).toMatchObject({ value: '1780', lastMonth: '3000' })
    expect(theirs.profit).toBeNull()
    expect(theirs.moneyWent).toBeNull()
    expect(theirs.byDay?.days[0]?.profit ?? null).toBeNull()
    expect(theirs.topProducts?.byQuantity[0]?.profit ?? null).toBeNull()
    expect(theirs.topProducts?.byMargin ?? null).toBeNull()
    expect(theirs.concerns ?? null).toBeNull()
    expect(theirs.costIncreases ?? null).toBeNull()
    expect(theirs.needsLook ?? null).toBeNull()
    expect(theirs.byChannel?.[0]?.profit ?? null).toBeNull()
    expect(JSON.stringify(theirs)).not.toContain(names.unpriced)
  })

  it('the Employee: none (they see neither the sales totals nor profit)', async () => {
    const theirs = await cafe.cards(employee)
    for (const card of [
      'profit',
      'sales',
      'moneyWent',
      'byDay',
      'topProducts',
      'byChannel',
    ] as const) {
      expect(theirs[card], card).toBeNull()
    }
  })

  it('a business without sales: no card at all', async () => {
    const empty = await ProfitScope.open(api, CAFE)
    const theirs = await empty.cards()
    expect(theirs).toMatchObject({
      profit: null,
      sales: null,
      moneyWent: null,
      byDay: null,
      topProducts: null,
      concerns: null,
      costIncreases: null,
      byChannel: null,
      needsLook: null,
    })
  })
})
