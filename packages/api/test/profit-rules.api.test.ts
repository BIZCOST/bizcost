import type { LocationDto, MemberLocationsDto, ProductCostBreakdownDto } from '@bizcost/contracts'
import { addMonths, daysIn, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handlerFor, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { dayOf, lastOf, ProfitApi, ProfitScope, type Summary } from './profit'
import { codeOf, ok, purchaseInput } from './purchasing'
import { bought, CAFE, CAFE_BRANCHES, item } from './sales'
import { WORKSHOP } from './settings'

// Real profit's rules (ROADMAP.md M3 Step 3; D-223; Q3, Q6, Q8, Q11, Q12, Q13 of D-218): refunds,
// fees counted once, materials no product uses, a product sold without a list price, Sales switched
// off (M9), a member limited to some branches, and a released business (Sales not served) that sees
// no change before Release A (the plan's D3).

let api: ProfitApi

beforeAll(() => {
  api = new ProfitApi()
})

afterAll(async () => {
  await api.close()
})

const groupOf = (summary: Summary, key: string) => {
  const group = summary.groups.find((g) => g.key === key)
  if (!group) throw new Error(`no group ${key}`)
  return group
}

describe('a sale reversed on a later day: taken back in the month of its reversal (Q3, D-227)', () => {
  it('last month keeps it; this month’s sales and item sales take it back', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { month, last } = await shop.months()
    await shop.monthly('1000', dayOf(addMonths(last, -2), 1))
    const service = await shop.service('400')
    const channel = await shop.channelId()
    await shop.sell({
      businessDate: dayOf(last, 2),
      channelId: channel,
      lines: [item(service.id, '1', '1000')],
    })
    const refunded = await shop.sell({
      businessDate: dayOf(last, 3),
      channelId: channel,
      lines: [item(service.id, '1', '400')],
    })
    // Last month closed: the reversal is dated the first open day, this month.
    ok(await shop.run('books.close', { closedThrough: lastOf(last) }))
    const reversed = await shop.reverseSale(refunded.id)
    expect(reversed.reversalBusinessDate).toBe(dayOf(month, 1))
    ok(await shop.run('books.close', { closedThrough: null }))
    const before = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(before.total).toMatchObject({ sales: '1400', itemSales: '1400' })
    // Last month (the first, from its 2nd): 1,000 × 30 ÷ 31-style days … ÷ 1,400.
    expect(before.months[0]?.rateSales).toBe('1400')
    const now = await shop.summary({ from: dayOf(month, 1), to: lastOf(month), groupBy: 'day' })
    expect(groupOf(now, dayOf(month, 1))).toMatchObject({ sales: '-400', itemSales: '-400' })
    // The refund carries its share back at this month's rate (last month's), in its own sign.
    const rate = now.months[0]?.rate
    expect(rate).not.toBeNull()
    expect(Number(groupOf(now, dayOf(month, 1)).runningCosts)).toBeCloseTo(-400 * Number(rate), 9)
  })
})

describe('fees: a channel’s marked expenses, else its %, else "before app fees" (Q8)', () => {
  it('a delivery app without any carries no fees and says so; the shop never carries any', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    const service = await shop.service('100')
    const app = await shop.deliveryApp(null)
    const counter = await shop.channelId()
    await shop.sell({
      businessDate: dayOf(last, 5),
      channelId: app.id,
      lines: [item(service.id, '1', '100')],
    })
    await shop.sell({
      businessDate: dayOf(last, 5),
      channelId: counter,
      lines: [item(service.id, '1', '100')],
    })
    const summary = await shop.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'channel',
    })
    expect(groupOf(summary, app.id)).toMatchObject({
      fees: '0',
      complete: false,
      reasons: ['fees_not_entered'],
    })
    expect(groupOf(summary, counter)).toMatchObject({ fees: '0', complete: true, reasons: [] })
    expect(summary.completeness).toMatchObject({
      sales: '200',
      completeSales: '100',
      percent: '50',
      missing: [{ reason: 'fees_not_entered', sales: '100' }],
    })
    // A marked expense of another month changes nothing here; one of this month counts.
    await shop.expense('30', dayOf(last, 20), last, {
      pays: { kind: 'channel_fees', channelId: app.id },
    })
    const after = await shop.summary({ from: dayOf(last, 1), to: lastOf(last), groupBy: 'channel' })
    expect(groupOf(after, app.id)).toMatchObject({ fees: '30', complete: true })
  })
})

describe('materials no product uses count with the month’s costs (Q13 A, definition of done)', () => {
  it('the fit-out company: (20,000 + gypsum 4,000 in no recipe) ÷ 80,000 = 30 %', async () => {
    const fitout = await ProfitScope.open(api, WORKSHOP)
    const { last } = await fitout.months()
    const before = addMonths(last, -1)
    await fitout.monthly('20000', dayOf(addMonths(last, -2), 1))
    const work = await fitout.service('1')
    const channel = await fitout.channelId()
    await fitout.sell({
      businessDate: dayOf(before, 3),
      channelId: channel,
      lines: [item(work.id, '1', '1')],
    })
    const gypsum = await fitout.newMaterial({ name: `Gypsum ${tag()}`, unit: 'piece' })
    await fitout.buy(
      purchaseInput(dayOf(last, 6), [bought(gypsum.id, '100', '40', { unit: 'piece' })]),
    )
    await fitout.sell({
      businessDate: dayOf(last, 7),
      channelId: channel,
      lines: [item(work.id, '80000', '1')],
    })
    const summary = await fitout.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.months[0]).toMatchObject({ rateCosts: '24000', rateSales: '80000', rate: '0.3' })
    expect(summary.total).toMatchObject({ monthCosts: '24000', profit: '56000' })
    // In a recipe it is each item's own line again, not a running cost.
    const panel = await fitout.product({ name: `Panel ${tag()}`, defaultPrice: '10' })
    await fitout.recipe(panel.id, [{ id: newId(), materialId: gypsum.id, qty: '1', unit: 'piece' }])
    const inRecipe = await fitout.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(inRecipe.months[0]).toMatchObject({ rateCosts: '20000', rate: '0.25' })
  })

  it('Product costs show them with the month’s costs, by name to a member who sees purchases', async () => {
    const fitout = await ProfitScope.open(api, WORKSHOP)
    const { last } = await fitout.months()
    await fitout.monthly('1000', dayOf(addMonths(last, -2), 1))
    const work = await fitout.service('100')
    const gypsum = await fitout.newMaterial({ name: `Gypsum ${tag()}`, unit: 'piece' })
    await fitout.buy(
      purchaseInput(dayOf(last, 6), [bought(gypsum.id, '10', '50', { unit: 'piece' })]),
    )
    await fitout.sell({
      businessDate: dayOf(last, 1),
      channelId: await fitout.channelId(),
      lines: [item(work.id, '30', '100')],
    })
    const breakdown = await fitout.breakdown(work.id)
    expect(breakdown.monthCosts).toMatchObject({
      basis: 'last_month',
      month: last,
      total: '1500',
      sales: '3000',
      rate: '0.5',
      materials: [{ materialId: gypsum.id, name: gypsum.name, amount: '500' }],
    })
    expect(breakdown.cost.runningCosts).toEqual({ state: 'applied', amount: '50' })
  })
})

describe('a product without a list price (D-202): no_price on Product costs, its share at the price sold', () => {
  it('real profit carries 25 % of what it was sold for', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    await shop.monthly('250', dayOf(addMonths(last, -2), 1))
    const custom = await shop.product({
      name: `Custom cake ${tag()}`,
      type: 'service',
      defaultPrice: null,
    })
    await shop.sell({
      businessDate: dayOf(last, 1),
      channelId: await shop.channelId(),
      lines: [item(custom.id, '1', '1000')],
    })
    const summary = await shop.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'product',
    })
    expect(groupOf(summary, custom.id)).toMatchObject({ runningCosts: '250', profit: '750' })
    const breakdown = await shop.breakdown(custom.id)
    expect(breakdown.cost.runningCosts).toEqual({ state: 'no_price', amount: null })
    expect(breakdown.cost.reasons).toContain('no_price')
  })
})

describe('Sales switched off in Customize (M9): sales already posted still count', () => {
  it('reports, the cards and Product costs keep them; the sales screens go', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    await shop.monthly('100', dayOf(addMonths(last, -2), 1))
    const service = await shop.service('400')
    await shop.sell({
      businessDate: dayOf(last, 1),
      channelId: await shop.channelId(),
      lines: [item(service.id, '1', '400')],
    })
    ok(
      await shop.run('business.customize', {
        item: { kind: 'module', id: 'sales' },
        enabled: false,
      }),
    )
    expect(codeOf(await shop.run('sale.list'))).toBe('module_disabled')
    const summary = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.total).toMatchObject({ sales: '400', monthCosts: '100', profit: '300' })
    expect((await shop.breakdown(service.id)).cost.runningCosts).toEqual({
      state: 'applied',
      amount: '100',
    })
    const cards = await shop.cards()
    expect(cards.sales).toMatchObject({ lastMonth: '400' })
    // Expenses can no longer say a channel's fees while Sales is off.
    expect(codeOf(await shop.run('expense.payableChannels'))).toBe('module_disabled')
  })
})

describe('a member limited to some branches (Q12): their branches, no business-level line', () => {
  it('sees their branch’s sales at the business’s rate, never the business’s costs or sales', async () => {
    const cafe = await ProfitScope.open(api, CAFE_BRANCHES)
    const { last } = await cafe.months()
    await cafe.monthly('1000', dayOf(addMonths(last, -2), 1))
    const branch = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const service = await cafe.service('100')
    const channel = await cafe.channelId()
    await cafe.sell({
      businessDate: dayOf(last, 1),
      channelId: channel,
      lines: [item(service.id, '30', '100')],
    })
    await cafe.sell({
      businessDate: dayOf(last, 2),
      channelId: channel,
      locationId: branch.id,
      lines: [item(service.id, '10', '100')],
    })
    const manager = await api.member(cafe, 'manager')
    const scope = ok(
      await cafe.run<MemberLocationsDto>('member.locations', { memberId: manager.memberId }),
    )
    ok(
      await cafe.run('member.updateLocations', {
        memberId: manager.memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    const owners = await cafe.summary({ from: dayOf(last, 1), to: lastOf(last), groupBy: 'branch' })
    expect(owners.total).toMatchObject({ sales: '4000', monthCosts: '1000' })
    expect(owners.groups).toHaveLength(2)
    const theirs = await cafe.summary(
      { from: dayOf(last, 1), to: lastOf(last), groupBy: 'branch' },
      manager,
    )
    expect(theirs).toMatchObject({ profitShown: true, businessLevel: false })
    expect(theirs.groups.map((g) => g.key)).toEqual([branch.id])
    // The business's rate (1,000 ÷ 4,000 = 25 %), carried by their 1,000 of sales: 250.
    expect(theirs.total).toMatchObject({
      sales: '1000',
      runningCosts: '250',
      monthCosts: null,
      notCarried: null,
      profit: '750',
    })
    expect(theirs.months[0]).toMatchObject({
      rate: '0.25',
      rateCosts: null,
      rateSales: null,
      costs: null,
      notCarried: null,
    })
    const cards = await cafe.cards(manager)
    expect(cards.sales).toMatchObject({ lastMonth: '1000' })
  })
})

describe('a released business sees no change before Release A (the plan’s D3)', () => {
  it('without the preview: Product costs await sales, no cards, Reports is not served', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    await shop.monthly('100', dayOf(addMonths(last, -2), 1))
    const service = await shop.service('400')
    await shop.sell({
      businessDate: dayOf(last, 1),
      channelId: await shop.channelId(),
      lines: [item(service.id, '1', '400')],
    })
    const released = handlerFor(api.db, undefined, { supabaseSecretKey: SECRET_KEY })
    const breakdown = ok(
      await api.call<ProductCostBreakdownDto>(
        shop.owner,
        shop.id,
        'productCost.get',
        { productId: service.id },
        released,
      ),
    ).data
    expect(breakdown.cost.runningCosts).toEqual({ state: 'awaiting_sales', amount: null })
    expect(breakdown.monthCosts).toMatchObject({
      state: 'awaiting_sales',
      basis: null,
      month: last,
    })
    const cards = ok(
      await api.call<{ data: Record<string, unknown> }>(
        shop.owner,
        shop.id,
        'dashboard.cards',
        undefined,
        released,
      ),
    ).data
    expect(cards).toMatchObject({ profit: null, sales: null, byDay: null, needsLook: null })
    const report = await api.call(
      shop.owner,
      shop.id,
      'profit.summary',
      { from: dayOf(last, 1), to: lastOf(last) },
      released,
    )
    expect(codeOf(report)).toBe('module_disabled')
  })
})

describe('a first month while it runs (Q6): before 7 days of sales, then so far', () => {
  it('says "before running costs" before the 7th day of sales, then its costs so far ÷ its sales so far', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { today, month } = await shop.months()
    const day = Number(today.slice(8, 10))
    const days = daysIn(month)
    // The month's rent bill: 200 a day; sales so far of 800 a day, from the 1st.
    await shop.expense(String(days * 200), dayOf(month, 1), month)
    const service = await shop.service('1')
    await shop.sell({
      businessDate: dayOf(month, 1),
      channelId: await shop.channelId(),
      lines: [item(service.id, String(800 * day), '1')],
    })
    const summary = await shop.summary({ from: dayOf(month, 1), to: lastOf(month) })
    const breakdown = await shop.breakdown(service.id)
    if (day >= 7) {
      expect(summary.months[0]).toMatchObject({ state: 'applied', basis: 'so_far', rate: '0.25' })
      expect(breakdown.cost.runningCosts).toEqual({ state: 'applied', amount: '0.25' })
    } else {
      expect(summary.months[0]).toMatchObject({
        state: 'before_running_costs',
        basis: 'so_far',
        rate: null,
        showsOn: dayOf(month, 7),
      })
      expect(summary.total.beforeRunningCosts).toBe(false)
      expect(breakdown.cost.runningCosts).toEqual({ state: 'before_running_costs', amount: null })
      expect(breakdown.monthCosts).toMatchObject({
        state: 'before_running_costs',
        showsOn: dayOf(month, 7),
      })
    }
    // The business takes off its costs so far either way: 200 a day.
    expect(summary.total.monthCosts).toBe(String(200 * day))
  })
})
