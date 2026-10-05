import type { ProductDto, SalesChannelDto } from '@bizcost/contracts'
import { addMonths, daysIn, monthOf, roundForDisplay } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, ok } from './purchasing'
import { dayOf, lastOf, ProfitApi, ProfitScope, type Summary } from './profit'
import { BAKER } from './settings'
import { CAFE, delivery, item } from './sales'

// Real profit, worked out on read (ROADMAP.md M3 Step 3; D-223; Q6–Q8, Q13 of D-218), through the API
// with the dev-only preview of Sales and Reports (D-125). The definition-of-done numbers, with months
// counted from the business's today so they hold on any day:
//   - the café's last full month: 20,000 ÷ 80,000 = 25 %; an AED 18.00 latte carries 4.50 and earns
//     10.50 dine-in; on Talabat 20 % commission carries 3.60, and once its fees of 1,800 are marked on
//     an expense (1,800 ÷ 10,000 = 18 %) 3.24, earning 7.26; the business 80,000 − 24,000 − 1,800 −
//     20,000 = 34,200 (42.75 %), by month, week, day, product, channel and branch;
//   - the running month at the last full month's rate, the business taking off its costs so far;
//   - a first month: 6,000-style rent so far over sales so far = 25 % (from its first sale);
//   - the home baker's sale: 150 − 32.40 − 37.50 − 40 + (20 − 25) = 35.10;
//   - Running Costs and Expenses off: `off`; refunds; fees counted once; materials in no recipe.

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

describe('the café’s last full month (definition of done)', () => {
  let cafe: ProfitScope
  let month: string
  let last: string
  let shop: SalesChannelDto
  let talabat: SalesChannelDto
  let platter: ProductDto

  beforeAll(async () => {
    cafe = await ProfitScope.open(api, CAFE)
    ;({ month, last } = await cafe.months())
    const before = addMonths(last, -1)
    // Running costs of 20,000 a month since before the month.
    await cafe.monthly('20000', dayOf(addMonths(last, -2), 1))
    // A platter at 100 before VAT made of one kit bought at 30.00: materials are 30 % of its price.
    const kit = await cafe.pieceMaterial('Platter kit', '30', dayOf(before, 1), '2000')
    platter = await cafe.madeOf(kit, '100')
    shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
    talabat = await cafe.deliveryApp('20')
    // A first sale the month before, so the last full month is a month of its own (`month`).
    await cafe.sell({
      businessDate: dayOf(before, 10),
      channelId: shop.id,
      lines: [item(platter.id, '1', '100')],
    })
    // The month: 700 platters dine-in and 100 on Talabat, 80,000 before VAT.
    await cafe.sell({
      businessDate: dayOf(last, 2),
      channelId: shop.id,
      lines: [item(platter.id, '700', '100')],
    })
    await cafe.sell({
      businessDate: dayOf(last, 3),
      channelId: talabat.id,
      lines: [item(platter.id, '100', '100')],
    })
  }, 180_000)

  const monthInput = () => ({ from: dayOf(last, 1), to: lastOf(last) })

  it('with only Talabat’s 20 % commission: fees 2,000; the rate 20,000 ÷ 80,000 = 25 %', async () => {
    const summary = await cafe.summary({ ...monthInput(), groupBy: 'channel' })
    expect(summary).toMatchObject({ profitShown: true, businessLevel: true })
    expect(groupOf(summary, talabat.id)).toMatchObject({
      name: talabat.name,
      sales: '10000',
      materials: '3000',
      fees: '2000',
      runningCosts: '2500',
      profit: '2500',
      complete: true,
    })
    expect(summary.months).toEqual([
      expect.objectContaining({
        month: last,
        state: 'applied',
        basis: 'month',
        rateMonth: last,
        rateCosts: '20000',
        rateSales: '80000',
        rate: '0.25',
        costs: '20000',
        notCarried: '0',
      }),
    ])
  })

  it('its fees marked on an expense (1,800 ÷ 10,000 = 18 %): counted once, never in running costs', async () => {
    await cafe.expense('1800', dayOf(last, 28), last, {
      pays: { kind: 'channel_fees', channelId: talabat.id },
      vatRate: '5',
    })
    const summary = await cafe.summary({ ...monthInput(), groupBy: 'channel' })
    expect(groupOf(summary, talabat.id)).toMatchObject({ fees: '1800', profit: '2700' })
    expect(groupOf(summary, shop.id)).toMatchObject({
      sales: '70000',
      materials: '21000',
      fees: '0',
      runningCosts: '17500',
      profit: '31500',
    })
    // The business: 80,000 − 24,000 − 1,800 − 20,000 = 34,200 (42.75 %).
    expect(summary.total).toMatchObject({
      sales: '80000',
      materials: '24000',
      fees: '1800',
      runningCosts: '20000',
      monthCosts: '20000',
      notCarried: '0',
      profit: '34200',
      marginPercent: '42.75',
      complete: true,
      beforeRunningCosts: false,
    })
    // The month's costs stay 20,000: the fees expense is not a running cost.
    expect(summary.months[0]).toMatchObject({ rateCosts: '20000', rate: '0.25' })
    expect(summary.completeness).toEqual({
      sales: '80000',
      completeSales: '80000',
      percent: '100',
      missing: [],
    })
  })

  it('the same 34,200 by month, week, day, product and channel (a finished month carries it all)', async () => {
    for (const groupBy of ['month', 'week', 'day', 'product', 'channel'] as const) {
      const summary = await cafe.summary({ ...monthInput(), groupBy })
      expect(summary.total.profit, groupBy).toBe('34200')
      const carried = summary.groups.reduce((sum, g) => sum + Number(g.profit), 0)
      expect(roundForDisplay(String(carried), 2), groupBy).toBe('34200.00')
    }
    const byProduct = await cafe.summary({ ...monthInput(), groupBy: 'product' })
    expect(groupOf(byProduct, platter.id)).toMatchObject({
      name: platter.name,
      quantity: '800',
      unit: 'piece',
      sales: '80000',
    })
  })

  it('the running month carries the last full month’s rate; the business takes off its costs so far', async () => {
    const today = await cafe.today()
    await cafe.sell({
      businessDate: today,
      channelId: shop.id,
      lines: [item(platter.id, '1', '18')],
    })
    const summary = await cafe.summary({ from: dayOf(month, 1), to: lastOf(month) })
    expect(summary.to).toBe(today)
    expect(summary.months[0]).toMatchObject({
      month,
      state: 'applied',
      basis: 'last_month',
      rateMonth: last,
      rate: '0.25',
    })
    // An item sold at 18 carries 18 × 25 % = 4.50.
    expect(summary.total.runningCosts).not.toBeNull()
    expect(summary.groups[0]).toMatchObject({ runningCosts: '4.5' })
    // Its costs so far: 20,000 × the days so far ÷ the month's days.
    const days = Number(today.slice(8, 10))
    const soFar = (20000 * days) / daysIn(month)
    expect(Number(summary.total.monthCosts)).toBeCloseTo(soFar, 6)
    expect(Number(summary.total.notCarried)).toBeCloseTo(soFar - 4.5, 6)
  })

  it('Product costs: the share is live, 25 % of its price, at the last full month’s rate', async () => {
    const breakdown = await cafe.breakdown(platter.id)
    expect(breakdown.cost.runningCosts).toEqual({ state: 'applied', amount: '25' })
    expect(breakdown.monthCosts).toMatchObject({
      state: 'applied',
      basis: 'last_month',
      month: last,
      from: null,
      to: null,
      rate: '0.25',
      total: '20000',
      sales: '80000',
    })
    expect(breakdown.margin).toEqual({ amount: '45', percent: '45' })
    expect(breakdown.cost).toMatchObject({ beforeRunningCosts: false, complete: true })
  })

  it('a period longer than 12 months, a day after today and grouping by branch without branches are refused', async () => {
    const today = await cafe.today()
    const tooLong = await cafe.as(cafe.owner, 'profit.summary', {
      from: dayOf(addMonths(monthOf(today), -12), 1),
      to: today,
    })
    expect(codeOf(tooLong)).toBe('validation')
    const future = await cafe.as(cafe.owner, 'profit.summary', {
      from: dayOf(addMonths(month, 1), 1),
      to: dayOf(addMonths(month, 1), 2),
    })
    expect(codeOf(future)).toBe('future_date')
    const branch = await cafe.as(cafe.owner, 'profit.summary', {
      ...monthInput(),
      groupBy: 'branch',
    })
    expect(codeOf(branch)).toBe('capability_disabled')
  })
})

describe('the Spanish Latte in the café’s last full month (definition of done)', () => {
  let cafe: ProfitScope
  let last: string
  let latte: ProductDto
  let talabat: SalesChannelDto

  beforeAll(async () => {
    cafe = await ProfitScope.open(api, CAFE)
    ;({ last } = await cafe.months())
    const before = addMonths(last, -1)
    await cafe.monthly('20000', dayOf(addMonths(last, -2), 1))
    ;({ latte } = await cafe.spanishLatte(dayOf(before, 1)))
    const catering = await cafe.service('1')
    const shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
    talabat = await cafe.deliveryApp('20')
    await cafe.sell({
      businessDate: dayOf(before, 5),
      channelId: shop.id,
      lines: [item(catering.id, '1', '1')],
    })
    // 80,000 of item sales: a latte and catering dine-in (70,000), a latte and catering on Talabat
    // (10,000), with Talabat's fees of 1,800 marked on an expense.
    await cafe.sell({
      businessDate: dayOf(last, 4),
      channelId: shop.id,
      lines: [item(latte.id, '1', '18'), item(catering.id, '69982', '1')],
    })
    await cafe.sell({
      businessDate: dayOf(last, 5),
      channelId: talabat.id,
      lines: [item(latte.id, '1', '18'), item(catering.id, '9982', '1')],
    })
    await cafe.expense('1800', dayOf(last, 28), last, {
      pays: { kind: 'channel_fees', channelId: talabat.id },
    })
  }, 180_000)

  it('the latte carries 4.50 on each line, 3.24 of fees on Talabat: 10.50 dine-in + 7.26 on Talabat', async () => {
    const summary = await cafe.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'product',
    })
    expect(groupOf(summary, latte.id)).toMatchObject({
      quantity: '2',
      sales: '36',
      materials: '6.00406926407',
      fees: '3.24',
      runningCosts: '9',
      // 10.497965367965 + 7.257965367965
      profit: '17.75593073593',
    })
    expect(roundForDisplay('10.497965367965', 2)).toBe('10.50')
    expect(roundForDisplay('7.257965367965', 2)).toBe('7.26')
    expect(summary.total).toMatchObject({ sales: '80000', fees: '1800', monthCosts: '20000' })
  })

  it('Product costs: «AED 4.50 · 25 % of its price (last month)»', async () => {
    const breakdown = await cafe.breakdown(latte.id)
    expect(breakdown.cost.runningCosts).toEqual({ state: 'applied', amount: '4.5' })
    expect(breakdown.monthCosts).toMatchObject({ basis: 'last_month', month: last, rate: '0.25' })
    expect(breakdown.margin.amount).toBe('10.497965367965')
  })
})

describe('a first month, finished: its costs from the first sale ÷ its sales so far (definition of done)', () => {
  it('a rent bill spread over the month from the first sale: 15 days of it ÷ 12,000 = 25 %', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    const days = daysIn(last)
    const first = days - 14
    // The month's rent bill: 200 a day, so its last 15 days count 3,000.
    await shop.expense(String(days * 200), dayOf(last, first), last)
    const catering = await shop.service('12000')
    const channel = await shop.channelId()
    await shop.sell({
      businessDate: dayOf(last, first),
      channelId: channel,
      lines: [item(catering.id, '1', '12000')],
    })
    const summary = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.months[0]).toMatchObject({
      state: 'applied',
      basis: 'so_far',
      rateFrom: dayOf(last, first),
      rateTo: lastOf(last),
      rateCosts: '3000',
      rateSales: '12000',
      rate: '0.25',
      costs: '3000',
      notCarried: '0',
    })
    expect(summary.total).toMatchObject({ runningCosts: '3000', profit: '9000' })
  })
})

describe('the home baker’s sale with delivery (definition of done: 35.10)', () => {
  it('150 − materials 32.40 − share 37.50 − her 60 minutes at 40/h, and delivery 20 that cost 25', async () => {
    const baker = await ProfitScope.open(api, BAKER)
    const { last } = await baker.months()
    const before = addMonths(last, -1)
    await baker.settings({ ownerHourlyRate: '40' })
    await baker.monthly('1000', dayOf(addMonths(last, -2), 1))
    const cakeKit = await baker.pieceMaterial('Cake ingredients', '32.4', dayOf(before, 1), '50')
    const cake = await baker.madeOf(cakeKit, '150', { ownerMinutes: '60' })
    const other = await baker.service('1')
    const channel = await baker.channelId()
    await baker.sell({
      businessDate: dayOf(before, 3),
      channelId: channel,
      lines: [item(other.id, '1', '1')],
    })
    const order = await baker.sell({
      businessDate: dayOf(last, 14),
      channelId: channel,
      lines: [item(cake.id, '1', '150'), delivery('20')],
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
    })
    // The rest of the month's 4,000 of item sales.
    await baker.sell({
      businessDate: dayOf(last, 20),
      channelId: channel,
      lines: [item(other.id, '3850', '1')],
    })
    const summary = await baker.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'day',
    })
    expect(groupOf(summary, order.businessDate)).toMatchObject({
      sales: '170',
      itemSales: '150',
      deliveryCharged: '20',
      materials: '32.4',
      runningCosts: '37.5',
      ownerTime: '40',
      deliveryCost: '25',
      deliveryMargin: '-5',
      profit: '35.1',
      complete: true,
    })
    expect(summary.months[0]).toMatchObject({ rate: '0.25', rateCosts: '1000', rateSales: '4000' })
  })
})

describe('Running Costs and Expenses off: nothing to share (`off`)', () => {
  it('the rate is off, no month’s costs are taken off, and Product costs say so', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    const catering = await shop.service('500')
    await shop.sell({
      businessDate: dayOf(last, 10),
      channelId: await shop.channelId(),
      lines: [item(catering.id, '2', '500')],
    })
    await switchOff(shop, ['running_costs', 'expenses'])
    const summary = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.months[0]).toMatchObject({ state: 'off', rate: null, costs: null })
    expect(summary.businessLevel).toBe(false)
    expect(summary.total).toMatchObject({
      sales: '1000',
      runningCosts: '0',
      monthCosts: null,
      profit: '1000',
    })
    const breakdown = await shop.breakdown(catering.id)
    expect(breakdown.cost.runningCosts.state).toBe('off')
    expect(breakdown.monthCosts.state).toBe('off')
  })
})

/** Switches modules off through Customize BizCost, as the owner. */
async function switchOff(scope: ProfitScope, ids: string[]) {
  for (const id of ids) {
    ok(await scope.run('business.customize', { item: { kind: 'module', id }, enabled: false }))
  }
}
