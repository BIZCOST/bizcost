import type { OrderDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectApi, handlerFor, mutate, SECRET_KEY, type CallResult } from './helpers'
import { ORDERS_PREVIEW, OrderScope, OrdersApi } from './orders'
import { ok, type Handler } from './purchasing'
import { BAKER } from './settings'

// Order numbers taken at the same time (ROADMAP.md M3 Step 5; Q16): each API instance below
// has its own database connection, like separate serverless functions, so their transactions really
// run together. The counter row is locked last (FOR UPDATE) and a replayed create is answered from the
// order before a number is taken, so 100 orders created at once are #1001–#1100 with no gap or twin,
// the same order sent several times at once takes one number, and two businesses count on their own.

const INSTANCES = 4

let api: OrdersApi
let dbs: Db[]
let handlers: Handler[]

beforeAll(() => {
  api = new OrdersApi()
  dbs = Array.from({ length: INSTANCES }, () => connectApi())
  handlers = dbs.map((db) =>
    handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY, previewModules: ORDERS_PREVIEW }),
  )
})

afterAll(async () => {
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** Creates an order as the owner of `scope` on instance `i`. */
function create(
  scope: OrderScope,
  i: number,
  input: object,
): Promise<CallResult<{ data: OrderDto }>> {
  return mutate<{ data: OrderDto }>(handlers[i % INSTANCES]!, 'order.create', {
    token: scope.owner.token,
    businessId: scope.id,
    input,
  })
}

function orderInput(today: string, extra: object = {}) {
  return { id: newId(), businessDate: today, notes: `Order ${newId().slice(-6)}`, ...extra }
}

const numbersOf = (results: CallResult<{ data: OrderDto }>[]) =>
  results.map((result) => ok(result).data.number)

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `#${from + i}`)

describe('order numbers at the same time', () => {
  it('100 orders created at once are #1001–#1100; a replay takes no number; businesses count apart', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const today = await baker.today()

    // 100 at once over four instances: every number once, none skipped.
    const first = await Promise.all(
      Array.from({ length: 100 }, (_, i) => create(baker, i, orderInput(today))),
    )
    const numbers = numbersOf(first)
    expect(new Set(numbers).size).toBe(100)
    expect([...numbers].sort()).toEqual(range(1001, 100))
    for (const result of first) {
      const order = ok(result).data
      expect(order.number).toBe(`#${order.seq}`)
    }

    // The same order sent five times at once: one order, one number; the next order is #1102.
    const same = orderInput(today, { notes: 'Wedding cake' })
    const replays = await Promise.all(Array.from({ length: 5 }, (_, i) => create(baker, i, same)))
    const once = replays.map((result) => ok(result).data)
    expect(new Set(once.map((order) => order.id))).toEqual(new Set([same.id]))
    expect(new Set(once.map((order) => order.number))).toEqual(new Set(['#1101']))
    const next = ok(await create(baker, 0, orderInput(today))).data
    expect(next.number).toBe('#1102')
    // And a replay after the fact still takes none.
    expect(ok(await create(baker, 1, same)).data.number).toBe('#1101')
    expect(ok(await create(baker, 2, orderInput(today))).data.number).toBe('#1103')

    // Another business, at the same time as the first: each counts from #1001 on its own.
    const other = await OrderScope.open(api, BAKER)
    const both = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? create(baker, i, orderInput(today)) : create(other, i, orderInput(today)),
      ),
    )
    const ours = numbersOf(both.filter((_, i) => i % 2 === 0))
    const theirs = numbersOf(both.filter((_, i) => i % 2 === 1))
    expect([...ours].sort()).toEqual(range(1104, 10))
    expect([...theirs].sort()).toEqual(range(1001, 10))
    // Each sees only its own orders.
    const list = ok(await other.as<{ items: { number: string }[] }>(other.owner, 'order.list', {}))
    expect(list.items.map((order) => order.number).sort()).toEqual(range(1001, 10))
  }, 120_000)
})
