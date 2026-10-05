import { addMonths, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { dayOf, lastOf, ProfitApi, ProfitScope } from './profit'
import { purchaseInput } from './purchasing'
import { BAKER } from './settings'
import { bought, item } from './sales'

// What each change makes stale (D-212, M3 Step 3): finalizing and reversing a sale, a purchase that
// fills a cost shown as "no price yet", an expense marked as a channel's fees, and the owner's hourly
// rate. Nothing is cached on the server: the next read of Reports (profit.summary), the Dashboard's
// cards and Product costs shows each change at once (the screens refresh what each change makes
// stale; statements come with Step 4).

let api: ProfitApi
let baker: ProfitScope
let last: string
let channel: string

beforeAll(async () => {
  api = new ProfitApi()
  baker = await ProfitScope.open(api, BAKER)
  ;({ last } = await baker.months())
  await baker.monthly('1000', dayOf(addMonths(last, -2), 1))
  channel = await baker.channelId()
}, 120_000)

afterAll(async () => {
  await api.close()
})

const period = () => ({ from: dayOf(last, 1), to: lastOf(last) })

describe('each change shows on the next read', () => {
  it('finalizing a sale and reversing it', async () => {
    const service = await baker.service('400')
    const before = await baker.summary(period())
    expect(before.total.sales).toBe('0')
    expect((await baker.breakdown(service.id)).cost.runningCosts.state).toBe('awaiting_sales')
    const sale = await baker.sell({
      businessDate: dayOf(last, 1),
      channelId: channel,
      lines: [item(service.id, '10', '400')],
    })
    const after = await baker.summary(period())
    expect(after.total).toMatchObject({ sales: '4000', monthCosts: '1000', profit: '3000' })
    expect((await baker.breakdown(service.id)).cost.runningCosts).toEqual({
      state: 'applied',
      amount: '100',
    })
    expect((await baker.cards()).sales?.lastMonth).toBe('4000')
    await baker.reverseSale(sale.id)
    expect((await baker.summary(period())).total.sales).toBe('0')
    expect((await baker.breakdown(service.id)).cost.runningCosts.state).toBe('awaiting_sales')
  })

  it('a purchase that fills a material with no price yet', async () => {
    const flour = await baker.newMaterial({ name: `Flour ${tag()}`, unit: 'piece' })
    const bread = await baker.product({ name: `Bread ${tag()}`, defaultPrice: '20' })
    await baker.recipe(bread.id, [{ id: newId(), materialId: flour.id, qty: '1', unit: 'piece' }])
    await baker.sell({
      businessDate: dayOf(last, 2),
      channelId: channel,
      lines: [item(bread.id, '5', '20')],
    })
    const before = await baker.summary({ ...period(), groupBy: 'product' })
    expect(before.groups.find((g) => g.key === bread.id)).toMatchObject({
      materials: '0',
      complete: false,
      reasons: ['unpriced_materials'],
    })
    await baker.buy(purchaseInput(dayOf(last, 3), [bought(flour.id, '10', '3', { unit: 'piece' })]))
    const after = await baker.summary({ ...period(), groupBy: 'product' })
    expect(after.groups.find((g) => g.key === bread.id)).toMatchObject({
      materials: '15',
      complete: true,
    })
  })

  it('an expense marked as a channel’s fees', async () => {
    const app = await baker.deliveryApp('25')
    const cake = await baker.service('100')
    await baker.sell({
      businessDate: dayOf(last, 4),
      channelId: app.id,
      lines: [item(cake.id, '2', '100')],
    })
    const byChannel = async () =>
      (await baker.summary({ ...period(), groupBy: 'channel' })).groups.find(
        (g) => g.key === app.id,
      )
    expect(await byChannel()).toMatchObject({ fees: '50' })
    await baker.expense('30', dayOf(last, 25), last, {
      pays: { kind: 'channel_fees', channelId: app.id },
    })
    expect(await byChannel()).toMatchObject({ fees: '30' })
  })

  it('the owner’s hourly rate', async () => {
    const cake = await baker.product({
      name: `Cake ${tag()}`,
      type: 'service',
      defaultPrice: '150',
      ownerMinutes: '60',
    })
    await baker.sell({
      businessDate: dayOf(last, 5),
      channelId: channel,
      lines: [item(cake.id, '1', '150')],
    })
    const byProduct = async () =>
      (await baker.summary({ ...period(), groupBy: 'product' })).groups.find(
        (g) => g.key === cake.id,
      )
    expect(await byProduct()).toMatchObject({
      ownerTime: '0',
      complete: false,
      reasons: ['hourly_rate_not_set'],
    })
    await baker.settings({ ownerHourlyRate: '40' })
    expect(await byProduct()).toMatchObject({ ownerTime: '40', complete: true })
  })
})
