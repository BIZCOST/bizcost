import type {
  ExpenseDto,
  ExpenseListDto,
  PayableChannelsDto,
  SalesChannelDto,
} from '@bizcost/contracts'
import { addMonths, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billOf, EXTRA, type Envelope } from './expenses'
import { handlerFor, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { dayOf, lastOf, ProfitApi, ProfitScope } from './profit'
import { codeOf, ok, type Person } from './purchasing'
import { CAFE, item } from './sales'

// What an expense pays, M3 Step 3 (the owner's answer Q8 = A, D-218): while Sales is served, any
// expense may say it pays "App fees of [channel]" (that channel's fees for its month when no
// statement covers it) or "Delivery already on my sales and orders"; neither ever counts in the
// month's costs. Said only by a member who sees costs with Sales on; the channel must be the
// business's (an archived one only when the expense already names it); the choice fits any category
// and month, so it stays when the category changes and satisfies the finalize requirement of D-216;
// a correction keeps it. The channels offered (expense.payableChannels) by name, never a commission %.

let api: ProfitApi
let shop: ProfitScope
let other: ProfitScope
let last: string
let talabat: SalesChannelDto
let theirs: SalesChannelDto
let employee: Person & { memberId: string }
let manager: Person & { memberId: string }

beforeAll(async () => {
  api = new ProfitApi()
  shop = await ProfitScope.open(api, CAFE)
  other = await ProfitScope.open(api, CAFE)
  ;({ last } = await shop.months())
  talabat = await shop.deliveryApp('17.5', `Talabat ${tag()}`)
  theirs = await other.deliveryApp('20')
  employee = await api.member(shop, 'employee')
  manager = await api.member(shop, 'manager')
}, 120_000)

afterAll(async () => {
  await api.close()
})

const fees = (channelId: string) => ({ kind: 'channel_fees', channelId })
const DELIVERY = { kind: 'delivery' }

async function draft(scope: ProfitScope, extra: object, person: Person = scope.owner) {
  const category = await scope.category(`Fees ${tag()}`)
  return scope.as<Envelope<ExpenseDto>>(
    person,
    'expense.create',
    scope.expenseInput(category.id, dayOf(last, 10), { periodMonth: last, ...extra }),
  )
}

describe('the channels an expense can pay the fees of', () => {
  it('the active channels by name, with their kind, never a commission %', async () => {
    const list = ok(await shop.run<PayableChannelsDto>('expense.payableChannels'))
    expect(list.items.map((c) => c.name)).toContain(talabat.name)
    expect(list.items.find((c) => c.id === talabat.id)).toEqual({
      id: talabat.id,
      name: talabat.name,
      kind: 'delivery_app',
    })
    expect(JSON.stringify(list)).not.toContain('17.5')
    expect(list.items.map((c) => c.id)).not.toContain(theirs.id)
  })

  it('only for a member who sees costs (FORBIDDEN), and only while Sales is served', async () => {
    expect(codeOf(await shop.as(employee, 'expense.payableChannels'))).toBe('forbidden')
    expect(codeOf(await shop.as(manager, 'expense.payableChannels'))).toBeUndefined()
    const released = handlerFor(api.db, undefined, { supabaseSecretKey: SECRET_KEY })
    const result = await api.call(
      shop.owner,
      shop.id,
      'expense.payableChannels',
      undefined,
      released,
    )
    expect(codeOf(result)).toBe('module_disabled')
  })
})

describe('saying it', () => {
  it('"App fees of Talabat": saved with the channel’s name, in any category', async () => {
    const saved = ok(await draft(shop, { pays: fees(talabat.id) })).data
    expect(saved.pays).toEqual({
      kind: 'channel_fees',
      runningCost: null,
      channel: { id: talabat.id, name: talabat.name },
    })
    const listed = ok(await shop.run<ExpenseListDto>('expense.list', { status: 'all', limit: 100 }))
    expect(listed.data.items.find((e) => e.id === saved.id)?.pays).toEqual(saved.pays)
  })

  it('"Delivery already on my sales and orders"', async () => {
    const saved = ok(await draft(shop, { pays: DELIVERY })).data
    expect(saved.pays).toEqual({ kind: 'delivery', runningCost: null, channel: null })
  })

  it('refused from a member who may not see costs, null too (FORBIDDEN, nothing written)', async () => {
    for (const pays of [fees(talabat.id), DELIVERY, null]) {
      expect(codeOf(await draft(shop, { pays }, employee))).toBe('forbidden')
    }
  })

  it('another business’s channel is NOT_FOUND; an archived one only when the expense names it already', async () => {
    expect(codeOf(await draft(shop, { pays: fees(theirs.id) }))).toBe('not_found')
    const old = await shop.deliveryApp(null, `Deliveroo ${tag()}`)
    const kept = ok(await draft(shop, { pays: fees(old.id) })).data
    ok(await shop.run('channel.archive', { id: old.id }))
    expect(codeOf(await draft(shop, { pays: fees(old.id) }))).toBe('validation')
    const again = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...updateOf(kept),
        pays: fees(old.id),
      }),
    ).data
    expect(again.pays?.channel?.id).toBe(old.id)
  })

  it('stays when the category changes (it fits any category), and is kept when left out', async () => {
    const saved = ok(await draft(shop, { pays: fees(talabat.id) })).data
    const moved = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...updateOf(saved),
        categoryId: (await shop.category(`Moved ${tag()}`)).id,
      }),
    ).data
    expect(moved.pays?.kind).toBe('channel_fees')
    // The employee may change their own expense's amount without touching what it pays.
    const own = ok(await draft(shop, {}, employee)).data
    expect(own.pays).toBeNull()
  })

  it('satisfies the finalize requirement in a category that has a running cost (D-216)', async () => {
    const category = await shop.category(`Rent ${tag()}`)
    const rent = await shop.runningCost({
      id: newId(),
      name: `Shop rent ${tag()}`,
      categoryId: category.id,
      amount: '1000',
      startsOn: dayOf(addMonths(last, -2), 1),
    })
    const input = shop.expenseInput(category.id, dayOf(last, 10), { periodMonth: last })
    const plain = ok(await shop.run<Envelope<ExpenseDto>>('expense.create', input)).data
    expect(codeOf(await shop.run('expense.post', { id: plain.id, version: plain.version }))).toBe(
      'running_cost_choice_required',
    )
    const posted = await shop.postExpense(plain, { kind: 'delivery' })
    expect(posted).toMatchObject({ status: 'posted', pays: { kind: 'delivery' } })
    // A bill and an extra still work as before.
    const bill = await shop.spend(
      shop.expenseInput(category.id, dayOf(last, 11), { periodMonth: last }),
      billOf(rent),
    )
    expect(bill.pays?.kind).toBe('running_cost')
    const extra = await shop.spend(
      shop.expenseInput(category.id, dayOf(last, 12), { periodMonth: last }),
      EXTRA,
    )
    expect(extra.pays?.kind).toBe('extra')
  })

  it('a correction keeps it; the one who finalizes may say it for a member who may not', async () => {
    const own = ok(await draft(shop, {}, employee)).data
    const posted = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.post', {
        id: own.id,
        version: own.version,
        pays: fees(talabat.id),
      }),
    ).data
    expect(posted.pays?.channel?.id).toBe(talabat.id)
    const copy = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.correct', { id: posted.id, newId: newId() }),
    ).data
    expect(copy.pays).toMatchObject({ kind: 'channel_fees', channel: { id: talabat.id } })
  })
})

describe('never in the month’s costs (Q8): fees stay with their channel, delivery with its sale', () => {
  it('a month’s costs, its rate and Product costs leave them out', async () => {
    const cafe = await ProfitScope.open(api, CAFE)
    const { last: previous } = await cafe.months()
    await cafe.monthly('1000', dayOf(addMonths(previous, -2), 1))
    const service = await cafe.service('100')
    const app = await cafe.deliveryApp('10')
    await cafe.sell({
      businessDate: dayOf(previous, 1),
      channelId: app.id,
      lines: [item(service.id, '40', '100')],
    })
    await cafe.expense('300', dayOf(previous, 20), previous, { pays: fees(app.id) })
    await cafe.expense('700', dayOf(previous, 21), previous, { pays: DELIVERY })
    const summary = await cafe.summary({ from: dayOf(previous, 1), to: lastOf(previous) })
    expect(summary.months[0]).toMatchObject({ rateCosts: '1000', rateSales: '4000', rate: '0.25' })
    // The channel's fees are its marked expense (300), not its 10 % (400).
    expect(summary.total).toMatchObject({ fees: '300', monthCosts: '1000' })
    const breakdown = await cafe.breakdown(service.id)
    expect(breakdown.monthCosts).toMatchObject({ total: '1000', rate: '0.25' })
  })
})

function updateOf(expense: ExpenseDto) {
  return {
    id: expense.id,
    version: expense.version,
    categoryId: expense.categoryId,
    supplierId: expense.supplierId,
    businessDate: expense.businessDate,
    periodMonth: expense.periodMonth,
    documentType: expense.documentType,
    paymentMethod: expense.paymentMethod,
    amount: expense.amount,
    vatRate: expense.vatRate,
  }
}
