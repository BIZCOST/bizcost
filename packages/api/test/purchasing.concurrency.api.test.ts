import type { PurchaseDto, PurchaseReturnDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId, replayWac, sumDecimals } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectApi, handlerFor, mutate, type CallResult } from './helpers'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope, type Handler } from './purchasing'
import { WORKSHOP } from './settings'

// Postings at the same time (D-110 rule 3; ROADMAP.md M2 Step 3 and the Step 8 definition of done):
// each API instance below has its own database connection, like separate serverless functions, so
// their transactions really run together. Postings on shared materials in opposite line orders never
// deadlock or lose an update and give the average of a serial replay in posting order; the same
// purchase posted many times at once comes in once; two returns racing for the last goods of a line,
// and a reversal racing a return, never both win.

const INSTANCES = 4

let api: PurchasingApi
let dbs: Db[]
let handlers: Handler[]
let shop: Scope
let today: string

beforeAll(async () => {
  api = new PurchasingApi()
  dbs = Array.from({ length: INSTANCES }, () => connectApi())
  handlers = dbs.map((db) => handlerFor(db))
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
}, 60_000)

afterAll(async () => {
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** Calls a mutation as the shop's owner on instance `i`. */
function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
  return mutate<T>(handlers[i % INSTANCES]!, path, {
    token: shop.owner.token,
    businessId: shop.id,
    input,
  })
}

describe('parallel postings on shared materials', () => {
  it('opposite line orders: no deadlock, no lost update, the average of a serial replay', async () => {
    const a = await shop.material()
    const b = await shop.material()
    const drafts: PurchaseDto[] = []
    for (let i = 0; i < 12; i++) {
      const price = String(5 + i)
      const lines =
        i % 2 === 0
          ? [line(a.id, '10', price), line(b.id, '3', price)]
          : [line(b.id, '7', price), line(a.id, '2', price)]
      drafts.push(await shop.draft(purchaseInput(today, lines)))
    }
    const results = await Promise.all(
      drafts.map((draft, i) =>
        on<{ data: PurchaseDto }>(i, 'purchase.post', { id: draft.id, version: draft.version }),
      ),
    )
    for (const result of results) expect(result.error, result.raw).toBeUndefined()

    const totals = {
      a: { qty: [] as string[], value: [] as string[] },
      b: { qty: [] as string[], value: [] as string[] },
    }
    for (const result of results) {
      for (const l of result.data!.data.lines) {
        const key = l.materialId === a.id ? 'a' : 'b'
        totals[key].qty.push(l.baseQty!)
        totals[key].value.push(l.cost!)
      }
    }
    for (const [material, key] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const row = await shop.costRow(material.id)
      // Nothing lost: every posted line is in the cost row.
      expect(row).toMatchObject({
        qty: sumDecimals(totals[key].qty),
        value: sumDecimals(totals[key].value),
      })
      // The row is the serial replay of the ledger in posting order.
      const { state } = replayWac(await shop.ledger(material.id))
      expect(row).toEqual({ qty: state.qty, value: state.value, avg_cost: state.avgCost })
    }
    await shop.expectRebuildEqualsProjections()
  })

  it('the same purchase posted many times at once comes in once', async () => {
    const milk = await shop.material()
    const draft = await shop.draft(
      purchaseInput(today, [line(milk.id, '10', '6'), line(milk.id, '5', '7')]),
    )
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        on<{ data: PurchaseDto }>(i, 'purchase.post', { id: draft.id, version: draft.version }),
      ),
    )
    for (const result of results) {
      expect(result.error, result.raw).toBeUndefined()
      expect(result.data?.data.status).toBe('posted')
    }
    const [count] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements where material_id = ${milk.id}`
    expect(count?.n).toBe(2)
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '15000',
      value: '95',
      avg_cost: '0.006333333333',
    })
  })
})

describe('races between documents of one purchase', () => {
  it('two returns racing for the last goods of a line: one wins, the other is refused', async () => {
    const milk = await shop.material()
    const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '100', '7')]))
    const lineId = purchase.lines[0]!.id
    const drafts: PurchaseReturnDto[] = []
    for (let i = 0; i < 4; i++) {
      drafts.push(
        await shop.returnDraft({
          id: newId(),
          purchaseId: purchase.id,
          kind: 'return',
          businessDate: today,
          lines: [{ id: newId(), purchaseLineId: lineId, qty: '60' }],
        }),
      )
    }
    const results = await Promise.all(
      drafts.map((d, i) =>
        on<{ data: PurchaseReturnDto }>(i, 'purchaseReturn.post', { id: d.id, version: d.version }),
      ),
    )
    const won = results.filter((r) => r.error === undefined)
    expect(won).toHaveLength(1)
    for (const lost of results.filter((r) => r.error !== undefined)) {
      expect(codeOf(lost)).toBe('exceeds_purchase')
    }
    expect(await shop.costRow(milk.id)).toMatchObject({ qty: '40000', value: '280' })
    await shop.expectRebuildEqualsProjections()
  })

  it('a reversal racing a return: never both', async () => {
    for (let round = 0; round < 3; round++) {
      const milk = await shop.material()
      const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '10', '5')]))
      const draft = await shop.returnDraft({
        id: newId(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '4' }],
      })
      const [reversal, ret] = await Promise.all([
        on(round, 'purchase.reverse', { id: purchase.id }),
        on(round + 1, 'purchaseReturn.post', { id: draft.id, version: draft.version }),
      ])
      const outcome = [codeOf(reversal) ?? 'ok', codeOf(ret) ?? 'ok'].join(' / ')
      expect(['ok / document_not_posted', 'purchase_has_returns / ok']).toContain(outcome)
      const row = await shop.costRow(milk.id)
      if (outcome.startsWith('ok')) expect(row).toMatchObject({ qty: '0', value: '0' })
      else expect(row).toMatchObject({ qty: '6000', value: '30' })
      await shop.expectRebuildEqualsProjections()
    }
  })

  it('corrections of one purchase at once: no deadlock, reversed once, a copy each', async () => {
    const milk = await shop.material()
    const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '10', '5')]))
    const copies = Array.from({ length: 4 }, () => newId())
    const results = await Promise.all(
      copies.map((newIdOfCopy, i) =>
        on<{ data: PurchaseDto }>(i, 'purchase.correct', { id: purchase.id, newId: newIdOfCopy }),
      ),
    )
    for (const result of results) {
      expect(result.error, result.raw).toBeUndefined()
      expect(result.data?.data).toMatchObject({ status: 'draft', copiedFromId: purchase.id })
    }
    const [reversals] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements
       where material_id = ${milk.id} and kind = 'reversal'`
    expect(reversals?.n).toBe(1)
    expect(await shop.costRow(milk.id)).toMatchObject({ qty: '0', value: '0' })
    await shop.expectRebuildEqualsProjections()
  })

  it('closing the books while postings run: each posting sees the date as it was or waits for it', async () => {
    const scope = await Scope.open(api, WORKSHOP)
    const milk = await scope.material()
    const drafts: PurchaseDto[] = []
    for (let i = 0; i < 6; i++) {
      drafts.push(await scope.draft(purchaseInput(today, [line(milk.id, '1', String(i + 1))])))
    }
    const calls = drafts.map((d, i) =>
      mutate<{ data: PurchaseDto }>(handlers[i % INSTANCES]!, 'purchase.post', {
        token: scope.owner.token,
        businessId: scope.id,
        input: { id: d.id, version: d.version },
      }),
    )
    const close = mutate(handlers[3]!, 'books.close', {
      token: scope.owner.token,
      businessId: scope.id,
      input: { closedThrough: today },
    })
    const results = await Promise.all([...calls, close])
    expect(results.at(-1)?.error).toBeUndefined()
    const posted = results.slice(0, -1).filter((r) => r.error === undefined)
    for (const refused of results.slice(0, -1).filter((r) => r.error !== undefined)) {
      expect(codeOf(refused)).toBe('books_closed')
    }
    // Whatever posted is in the ledger, and nothing else.
    const [count] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements where material_id = ${milk.id}`
    expect(count?.n).toBe(posted.length)
    ok(await scope.run('books.close', { closedThrough: null }))
    await scope.expectRebuildEqualsProjections()
  })
})
