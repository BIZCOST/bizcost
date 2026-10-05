import type { RecipeResultDto } from '@bizcost/contracts'
import { addMonths, daysIn, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { dayOf, lastOf, ProfitApi, ProfitScope, type Summary } from './profit'
import { ok } from './purchasing'
import { BAKER } from './settings'
import { CAFE, item } from './sales'

// The profit-maths adversary of M3 Step 3 (ROADMAP.md; D-237–D-239; Q6, Q8, Q13 of D-218): concrete
// numbers where real profit counts something twice, never, or says it is complete when it is not.
// Each case is a failing test of a real issue; nothing here fixes anything.

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

describe('Q13 A × frozen sale costs: a material taken out of a recipe after its sales froze it', () => {
  it('its purchases must not also count with the month’s costs (counted twice)', async () => {
    // The café's last full month: running costs 20,000; 1,000 platter kits bought on its 1st at 30.00
    // (30,000); 800 platters sold at 100 on its 2nd, each freezing one kit at 30.00 (materials 24,000).
    // Real profit: 80,000 − 24,000 − 20,000 = 36,000. Then the owner switches the platter's recipe to a
    // new kit. usedMaterials is read "at the time of the question" (D-238), so the old kit is now "in
    // no recipe" and its 30,000 purchase joins last month's costs, while last month's sales still carry
    // the 24,000 of it they froze: 24,000 is taken off twice and last month's profit falls to 6,000.
    const cafe = await ProfitScope.open(api, CAFE)
    const { last } = await cafe.months()
    const before = addMonths(last, -1)
    await cafe.monthly('20000', dayOf(addMonths(last, -2), 1))
    const opening = await cafe.service('1')
    const channel = await cafe.channelId()
    await cafe.sell({
      businessDate: dayOf(before, 5),
      channelId: channel,
      lines: [item(opening.id, '1', '1')],
    })
    const kit = await cafe.pieceMaterial('Platter kit', '30', dayOf(last, 1), '1000')
    const newKit = await cafe.pieceMaterial('Platter kit v2', '31', dayOf(before, 1), '1000')
    const platter = await cafe.product({ name: `Platter ${tag()}`, defaultPrice: '100' })
    const recipe = await cafe.recipe(platter.id, [
      { id: newId(), materialId: kit.id, qty: '1', unit: 'piece' },
    ])
    await cafe.sell({
      businessDate: dayOf(last, 2),
      channelId: channel,
      lines: [item(platter.id, '800', '100')],
    })
    const month = { from: dayOf(last, 1), to: lastOf(last) }
    const first = await cafe.summary(month)
    expect(first.total).toMatchObject({
      sales: '80000',
      materials: '24000',
      monthCosts: '20000',
      profit: '36000',
    })

    ok(
      await cafe.run<RecipeResultDto>('recipe.save', {
        productId: platter.id,
        version: recipe.version,
        lines: [{ id: newId(), materialId: newKit.id, qty: '1', unit: 'piece' }],
      }),
    )
    const after = await cafe.summary(month)
    // Nothing about last month changed: what its sales used is still each sale's own materials.
    expect(after.total.materials).toBe('24000')
    expect(after.total.monthCosts, 'the frozen kits counted again as running costs').toBe('20000')
    expect(after.total.profit).toBe('36000')
  }, 180_000)
})

describe('Q8: an expense marked as a channel’s fees, for a month that channel sold nothing in', () => {
  it('is still taken off the business’s real profit (now it is counted nowhere)', async () => {
    // Last month: 1,000 sold at the counter, nothing on Talabat; Talabat's invoice of 300 is entered as
    // an expense marked "App fees of Talabat" for last month (its monthly fee, or a statement the
    // owner dated in the month after the sales it covers). costPool skips it (paysCountInCosts) and
    // feeOf gives 0 when the channel's item sales are 0, so the 300 the business paid is in no
    // figure: the business shows 1,000 of profit for a month it kept 700.
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    const before = addMonths(last, -1)
    const service = await shop.service('1000')
    const counter = await shop.channelId()
    const talabat = await shop.deliveryApp(null)
    await shop.sell({
      businessDate: dayOf(before, 5),
      channelId: counter,
      lines: [item(service.id, '1', '1')],
    })
    await shop.sell({
      businessDate: dayOf(last, 5),
      channelId: counter,
      lines: [item(service.id, '1', '1000')],
    })
    await shop.expense('300', dayOf(last, 28), last, {
      pays: { kind: 'channel_fees', channelId: talabat.id },
    })
    const summary = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.businessLevel).toBe(true)
    expect(summary.total.sales).toBe('1000')
    expect(summary.total.profit, 'the 300 of fees the business paid is counted nowhere').toBe('700')
  }, 180_000)
})

describe('Q6 first month × Q9 day sheets: the first sale is a sheet for several days', () => {
  it('the first month counts its costs from the sheet’s first day, not its last', async () => {
    // A business starts by entering last month's 1st–20th on one Today's sales sheet (period_from the
    // 1st, posted on the 20th, Q9): 6,000 of sales, then nothing else. A bill of 100 a day for the
    // month. Its first sale's day is read as min(business_date) = the 20th, so the rate divides only
    // the 20th–last day's costs (100 × (days − 19)) by sales made from the 1st, and the business level
    // takes off those days only: 1,900 of the costs of the days those sales were made in are never
    // set against them.
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    const days = daysIn(last)
    await shop.expense(String(days * 100), dayOf(last, 1), last)
    const service = await shop.service('1')
    await shop.sell({
      source: 'day_sheet',
      periodFrom: dayOf(last, 1),
      businessDate: dayOf(last, 20),
      channelId: await shop.channelId(),
      lines: [item(service.id, '6000', '1')],
    })
    const summary = await shop.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.months[0]).toMatchObject({
      state: 'applied',
      basis: 'so_far',
      rateFrom: dayOf(last, 1),
      rateCosts: String(days * 100),
      rateSales: '6000',
      costs: String(days * 100),
    })
    expect(summary.total.profit).toBe(String(6000 - days * 100))
  }, 180_000)
})

describe('H2 completeness × delivery: a delivery whose cost is not typed, with no delivery charged', () => {
  it('the completeness note says it is missing, as the total does', async () => {
    // The baker delivers a 100 order for free (delivery needed, no delivery line) and has not typed
    // what the delivery cost. The total says incomplete (delivery_cost_not_entered), but completeness
    // only looks at delivery *lines*: "100 % of sales have complete costs", nothing missing.
    const baker = await ProfitScope.open(api, BAKER)
    const { last } = await baker.months()
    const service = await baker.service('100')
    await baker.sell({
      businessDate: dayOf(last, 5),
      channelId: await baker.channelId(),
      lines: [item(service.id, '1', '100')],
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
    })
    const summary = await baker.summary({ from: dayOf(last, 1), to: lastOf(last) })
    expect(summary.total).toMatchObject({
      complete: false,
      reasons: ['delivery_cost_not_entered'],
    })
    expect(summary.completeness?.missing.map((m) => m.reason)).toContain(
      'delivery_cost_not_entered',
    )
    expect(summary.completeness?.percent).not.toBe('100')
  }, 180_000)
})

describe('H2 completeness × D-227: last month’s incomplete sale taken back this month', () => {
  it('never says more than 100 % of sales have complete costs, nor a negative amount missing', async () => {
    // Last month a 400 tray (a product with no recipe while Materials is on: no_recipe) was sold; last
    // month is closed, so its reversal is dated this month's first open day (D-227) and counts here as
    // −400 of sales. This month 1,000 of a service sold, complete. The month's sales: 600. Complete
    // lines: 1,000 (the reversal piece is a no_recipe line, so it is left out of completeSales), so the
    // note reads "166.67 % of sales have complete costs", and "No recipe yet" concerns −400 of sales.
    const shop = await ProfitScope.open(api, CAFE)
    const { month, last, today } = await shop.months()
    const tray = await shop.product({ name: `Tray ${tag()}`, defaultPrice: '400' })
    const service = await shop.service('1000')
    const channel = await shop.channelId()
    const sold = await shop.sell({
      businessDate: dayOf(last, 3),
      channelId: channel,
      lines: [item(tray.id, '1', '400')],
    })
    ok(await shop.run('books.close', { closedThrough: lastOf(last) }))
    await shop.reverseSale(sold.id)
    ok(await shop.run('books.close', { closedThrough: null }))
    await shop.sell({
      businessDate: today,
      channelId: channel,
      lines: [item(service.id, '1', '1000')],
    })
    const summary = await shop.summary({ from: dayOf(month, 1), to: lastOf(month) })
    expect(summary.total.sales).toBe('600')
    const completeness = summary.completeness!
    expect(Number(completeness.percent), `${completeness.percent} %`).toBeLessThanOrEqual(100)
    for (const missing of completeness.missing) {
      expect(Number(missing.sales), missing.reason).toBeGreaterThanOrEqual(0)
    }
  }, 180_000)
})

describe('Q8 × D-200: a fees expense of a closed month reversed into this month', () => {
  it('does not wipe out this month’s commission % (fees 0, "complete")', async () => {
    // Talabat keeps 20 %. Last month's Talabat fees (150) were entered as a marked expense; last month
    // is closed and the expense is reversed, so the reversal counts in this month (D-200). This month
    // Talabat sold 1,000 and nothing is marked as its fees for this month, so its fees are its 20 %:
    // 200 (Q8: "Without either, the channel's commission % applies"). channelFeeExpensesOf gives
    // Talabat 0 for this month (150 taken back, floored at 0), and channelFeesOf takes that 0 as "the
    // expenses marked as its fees": this month's Talabat lines carry no fees at all and say complete.
    const shop = await ProfitScope.open(api, CAFE)
    const { month, last, today } = await shop.months()
    const service = await shop.service('1000')
    const talabat = await shop.deliveryApp('20')
    await shop.sell({
      businessDate: dayOf(last, 5),
      channelId: talabat.id,
      lines: [item(service.id, '1', '1000')],
    })
    const fees = await shop.expense('150', dayOf(last, 28), last, {
      pays: { kind: 'channel_fees', channelId: talabat.id },
    })
    ok(await shop.run('books.close', { closedThrough: lastOf(last) }))
    ok(await shop.run('expense.reverse', { id: fees.id }))
    ok(await shop.run('books.close', { closedThrough: null }))
    await shop.sell({
      businessDate: today,
      channelId: talabat.id,
      lines: [item(service.id, '1', '1000')],
    })
    const summary = await shop.summary({
      from: dayOf(month, 1),
      to: lastOf(month),
      groupBy: 'channel',
    })
    expect(groupOf(summary, talabat.id)).toMatchObject({ sales: '1000', fees: '200' })
  }, 180_000)
})
