import type { MaterialDto, ProductDto, PurchaseDto, SaleDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAdmin, connectApi, handlerFor, mutate, type CallResult } from './helpers'
import { ledgerDrift } from './ledger'
import { tag } from './product-costs'
import { line, ok, purchaseInput, type Handler } from './purchasing'
import { CAFE, item, PREVIEW_MODULES, SalesApi, SaleScope, shift } from './sales'
import { BAKER } from './settings'

// Sales, purchases, their reversals and the fills at once on shared materials (ROADMAP.md M3 Step 2;
// D-110 extended by D-228; H4): 62 sales and 26 purchases in two rounds (the plan asks for 50 and 20), their lines in opposite
// orders, through six API instances, each with its own database connection (like separate serverless
// functions; each runs its own calls one after another, so which ones overlap is chance). Each round
// also mixes in:
//   - a material's FIRST purchase against a sale of it (the insert of its cost row: the sale either
//     sees the purchase or the purchase fills the sale, H4);
//   - a sale's reversal against the first purchase that fills it (the reversal touches only the
//     header, the fill only the lines: neither waits on the other, and the fill still happens);
//   - in the second round, reversals of the first round's sales and purchases.
// After each round:
//   - nothing was refused: no deadlock (it would come back as CONFLICT) and no internal error;
//   - no sale is left without the cost a purchase should have filled: a material row still without a
//     price has no purchase standing of its material (else the purchase that priced it would have
//     filled it, or the sale would have read it);
//   - each line's cost is the sum of its materials' once all are priced, and null before;
//   - sales take nothing out of stock: the projections are a serial replay of the purchases' ledger
//     (ledgerDrift).
// Since the rounds overlap by chance, each edge of the lock order is also forced (at the end, D-236):
// a purchase posted after a sale read the purchases; a first purchase holding its cost row while a
// sale posts; two purchases filling two materials of one line (lock 6); a reversal holding the header
// during a fill; the owner's hourly rate set while a sale posts, and a sale posted while it is set.

const INSTANCES = 6

let api: SalesApi
let dbs: Db[]
let handlers: Handler[]
let cafe: SaleScope
let today: string
let shopId: string
let shared: MaterialDto[]
let products: ProductDto[]

beforeAll(async () => {
  api = new SalesApi()
  dbs = Array.from({ length: INSTANCES }, () => connectApi())
  handlers = dbs.map((db) => handlerFor(db, undefined, { previewModules: PREVIEW_MODULES }))
  cafe = await SaleScope.open(api, CAFE)
  today = await cafe.today()
  shopId = await cafe.channelId()
  shared = [
    await cafe.material(),
    await cafe.material(),
    await cafe.material(),
    await cafe.material(),
  ]
  // Products whose recipes name the shared materials in different orders.
  const orders = [
    [0, 1, 2],
    [2, 1, 0],
    [3, 0, 2],
    [1, 3],
  ]
  products = []
  for (const order of orders) {
    const product = await cafe.product({ name: `Drink ${tag()}`, defaultPrice: '20' })
    await cafe.recipe(
      product.id,
      order.map((m) => ({
        id: newId(),
        materialId: shared[m]!.id,
        qty: `${100 + m * 10}`,
        unit: 'ml',
      })),
    )
    products.push(product)
  }
  // Prices for some of the shared materials before the rounds start.
  await cafe.buy(
    purchaseInput(shift(today, -20), [
      line(shared[0]!.id, '10', '4'),
      line(shared[1]!.id, '10', '6'),
    ]),
  )
}, 120_000)

afterAll(async () => {
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** A call as the owner on instance `i` (its own connection). */
function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
  return mutate<T>(handlers[i % INSTANCES]!, path, {
    token: cafe.owner.token,
    businessId: cafe.id,
    input,
  })
}

interface Call {
  readonly what: string
  readonly run: (instance: number) => Promise<CallResult<unknown>>
}

/** A product with a recipe of one material never bought (a race of its first purchase). */
async function unbought(): Promise<{ product: ProductDto; material: MaterialDto }> {
  const material = await cafe.material()
  const product = await cafe.product({ name: `Special ${tag()}`, defaultPrice: '25' })
  await cafe.recipe(product.id, [{ id: newId(), materialId: material.id, qty: '250', unit: 'ml' }])
  return { product, material }
}

async function runAll(calls: readonly Call[]) {
  // Interleaved: each instance takes every INSTANCES-th call, in a shuffled order.
  const order = calls.map((call, index) => ({ call, key: (index * 7919) % calls.length }))
  order.sort((a, b) => a.key - b.key)
  const results = await Promise.all(order.map(({ call }, i) => call.run(i)))
  const refused = results
    .map((result, i) => ({ what: order[i]!.call.what, result }))
    .filter(({ result }) => result.error !== undefined)
    .map(({ what, result }) => `${what}: ${result.error?.data.appCode} ${result.error?.message}`)
  expect(refused).toEqual([])
  return results
}

/** Every rule after a round (see the file's header). */
async function expectConsistent() {
  const missed = await api.admin<{ sale_id: string; material_id: string }[]>`
    select m.sale_id, m.material_id
      from app.sale_line_materials m
      join app.sales s on s.business_id = m.business_id and s.id = m.sale_id
     where m.business_id = ${cafe.id} and m.cost is null and s.status <> 'draft'
       and exists (
         select 1 from app.stock_movements r
          where r.business_id = m.business_id and r.material_id = m.material_id
            and r.kind = 'purchase'
            and not exists (
              select 1 from app.stock_movements x
               where x.business_id = r.business_id and x.reverses_id = r.id))`
  expect(missed).toEqual([])
  const wrongLines = await api.admin<{ id: string }[]>`
    select l.id
      from app.sale_lines l
      join app.sales s on s.business_id = l.business_id and s.id = l.sale_id
     where l.business_id = ${cafe.id} and s.status <> 'draft' and l.kind = 'item'
       and l.cost_basis = 'recipe'
       and l.cost is distinct from (
         select case when bool_and(m.cost is not null) then sum(m.cost) end
           from app.sale_line_materials m
          where m.business_id = l.business_id and m.sale_line_id = l.id and m.deleted_at is null)`
  expect(wrongLines).toEqual([])
  expect(await ledgerDrift(api.admin, cafe.id)).toEqual([])
}

describe('50 sales and 20 purchases at once, with reversals and fills (D-228)', () => {
  const postedSales: SaleDto[] = []
  const postedPurchases: PurchaseDto[] = []

  async function round(index: number) {
    const day = shift(today, -index)
    // The drafts first (one at a time: creating them is not what races).
    const saleDrafts: SaleDto[] = []
    for (let i = 0; i < 25; i++) {
      const a = products[i % products.length]!
      const b = products[(i + 1) % products.length]!
      const lines =
        i % 2 === 0
          ? [item(a.id, '2', '20'), item(b.id, '1', '20')]
          : [item(b.id, '1', '20'), item(a.id, '3', '20')]
      saleDrafts.push(await cafe.saleDraft({ businessDate: day, channelId: shopId, lines }))
    }
    const purchaseDrafts: PurchaseDto[] = []
    for (let i = 0; i < 7; i++) {
      const order = i % 2 === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0]
      purchaseDrafts.push(
        await cafe.draft(
          purchaseInput(
            shift(day, -(i % 3)),
            order.map((m) => line(shared[m]!.id, String(5 + i), `${3 + m}.${index}${i}`)),
          ),
        ),
      )
    }
    // First purchases racing a sale of their material, and reversals racing the fill of theirs.
    const firsts = [await unbought(), await unbought(), await unbought()]
    const firstSales = []
    const firstBuys = []
    for (const { product, material } of firsts) {
      firstSales.push(
        await cafe.saleDraft({
          businessDate: day,
          channelId: shopId,
          lines: [item(product.id, '1', '25')],
        }),
      )
      firstBuys.push(await cafe.draft(purchaseInput(day, [line(material.id, '4', '9')])))
    }
    const fills = [await unbought(), await unbought(), await unbought()]
    const toReverse = []
    const fillBuys = []
    for (const { product, material } of fills) {
      toReverse.push(
        await cafe.sell({
          businessDate: day,
          channelId: shopId,
          lines: [item(product.id, '2', '25')],
        }),
      )
      fillBuys.push(await cafe.draft(purchaseInput(day, [line(material.id, '3', '7')])))
    }

    const calls: Call[] = [
      ...saleDrafts.map((s, i) => ({
        what: `post sale ${i}`,
        run: (n: number) => on(n, 'sale.post', { id: s.id, version: s.version }),
      })),
      ...purchaseDrafts.map((p, i) => ({
        what: `post purchase ${i}`,
        run: (n: number) => on(n, 'purchase.post', { id: p.id, version: p.version }),
      })),
      ...firstSales.map((s, i) => ({
        what: `post a sale of material ${i} never bought`,
        run: (n: number) => on(n, 'sale.post', { id: s.id, version: s.version }),
      })),
      ...firstBuys.map((p, i) => ({
        what: `post the first purchase of material ${i}`,
        run: (n: number) => on(n, 'purchase.post', { id: p.id, version: p.version }),
      })),
      ...toReverse.map((s, i) => ({
        what: `reverse sale ${i} waiting for a price`,
        run: (n: number) => on(n, 'sale.reverse', { id: s.id }),
      })),
      ...fillBuys.map((p, i) => ({
        what: `post the purchase that fills sale ${i}`,
        run: (n: number) => on(n, 'purchase.post', { id: p.id, version: p.version }),
      })),
      // The round before: some of its sales and purchases reversed.
      ...postedSales.splice(0, 5).map((s, i) => ({
        what: `reverse an earlier sale ${i}`,
        run: (n: number) => on(n, 'sale.reverse', { id: s.id }),
      })),
      ...postedPurchases.splice(0, 2).map((p, i) => ({
        what: `reverse an earlier purchase ${i}`,
        run: (n: number) => on(n, 'purchase.reverse', { id: p.id }),
      })),
    ]
    const results = await runAll(calls)
    for (const result of results) {
      const data = (result.data as { data?: { id: string; status: string } } | undefined)?.data
      if (!data || data.status !== 'posted') continue
      if (saleDrafts.some((s) => s.id === data.id)) postedSales.push(data as unknown as SaleDto)
      if (purchaseDrafts.some((p) => p.id === data.id)) {
        postedPurchases.push(data as unknown as PurchaseDto)
      }
    }
    await expectConsistent()
    // Each sale that raced its material's first purchase has its price now; so has each reversed one.
    for (const s of [...firstSales, ...toReverse]) {
      const sale = ok(await cafe.run<{ data: SaleDto }>('sale.get', { id: s.id })).data
      expect(sale.lines[0]?.cost, sale.id).not.toBeNull()
    }
    for (const s of toReverse) {
      expect(ok(await cafe.run<{ data: SaleDto }>('sale.get', { id: s.id })).data.status).toBe(
        'reversed',
      )
    }
  }

  it('round 1: sales, purchases, first purchases and fills racing', async () => {
    await round(1)
  }, 180_000)

  it('round 2: the same, with reversals of round 1', async () => {
    await round(2)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------
// Forced interleavings (D-228, D-236): the rounds above race by chance; these force each edge of the
// lock order. An admin connection holds a row one call needs; the calls start one after the other on
// their own instances, each once the ones before it wait on a lock (pg_locks); then the holder
// commits and they all finish, none refused, nothing left unpriced that a standing purchase prices.
// ---------------------------------------------------------------------------------------------------

type Holder = (sql: postgres.TransactionSql) => Promise<unknown>
type Run = (instance: number) => Promise<CallResult<unknown>>

/** The database backend of instance `i`'s connection (its pool has one). */
async function backendOf(i: number): Promise<number> {
  const [row] = await dbs[i % INSTANCES]!.$client<{ pid: number }[]>`select pg_backend_pid() as pid`
  return row!.pid
}

/** Waits until `count` of these backends wait on a lock (30 s at most). */
async function untilWaiting(pids: readonly number[], count: number, what: string) {
  for (let tries = 0; tries < 600; tries++) {
    const [row] = await api.admin<{ n: number }[]>`
      select count(distinct pid)::int as n from pg_locks
       where not granted and pid = any(${`{${pids.join(',')}}`}::int[])`
    if (row!.n >= count) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${what}: ${count} calls were expected to wait on a lock`)
}

/**
 * `hold` takes its locks in an admin transaction; each of `runs` starts on its own instance once the
 * ones before it wait; when all wait, the holder commits. Their results, none refused.
 */
async function interleaved(what: string, hold: Holder, runs: readonly Run[]) {
  const holder = connectAdmin()
  try {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let holding!: () => void
    const held = new Promise<void>((resolve) => (holding = resolve))
    const transaction = holder.begin(async (sql) => {
      await hold(sql)
      holding()
      await released
    })
    await held
    const pids = await Promise.all(runs.map((_, i) => backendOf(i)))
    const running: Promise<CallResult<unknown>>[] = []
    for (const [i, run] of runs.entries()) {
      running.push(run(i))
      await untilWaiting(pids.slice(0, i + 1), i + 1, what)
    }
    release()
    await transaction
    const results = await Promise.all(running)
    expect(
      results.filter((r) => r.error).map((r) => `${r.error?.data.appCode} ${r.error?.message}`),
      what,
    ).toEqual([])
    return results
  } finally {
    await holder.end()
  }
}

/** A call as `scope`'s owner on instance `i`. */
function callAs(
  scope: SaleScope,
  i: number,
  path: string,
  input: object,
): Promise<CallResult<unknown>> {
  return mutate(handlers[i % INSTANCES]!, path, {
    token: scope.owner.token,
    businessId: scope.id,
    input,
  })
}

/** The cost rows of a sale as stored: each line's cost and time cost, and its unpriced materials. */
async function costsOf(saleId: string) {
  const sale = ok(await cafe.run<{ data: SaleDto }>('sale.get', { id: saleId })).data
  return sale.lines.map((l) => ({
    cost: l.cost ?? null,
    timeCost: l.timeCost ?? null,
    unpriced: (l.materials ?? []).filter((m) => m.cost === null).length,
  }))
}

describe('each edge of the lock order, forced (D-228)', () => {
  it('a purchase posted while a sale has read the purchases waits for it and fills it', async () => {
    const { product, material } = await unbought()
    const sale = await cafe.saleDraft({
      businessDate: today,
      channelId: shopId,
      lines: [item(product.id, '1', '25')],
    })
    const purchase = await cafe.draft(purchaseInput(today, [line(material.id, '4', '9')]))
    // The sale is held at its lines' update: it has its cost rows FOR SHARE and has read no purchase.
    await interleaved(
      'sale then purchase',
      (sql) => sql`select id from app.sale_lines where sale_id = ${sale.id} for update`,
      [
        (i) => callAs(cafe, i, 'sale.post', { id: sale.id, version: sale.version }),
        (i) => callAs(cafe, i, 'purchase.post', { id: purchase.id, version: purchase.version }),
      ],
    )
    // 250 ml at 9 a litre, filled by the purchase once the sale committed.
    expect(await costsOf(sale.id)).toEqual([{ cost: '2.25', timeCost: null, unpriced: 0 }])
    await expectConsistent()
  }, 60_000)

  it('a material’s first purchase holding its cost row makes the sale wait, and the sale reads it', async () => {
    const { product, material } = await unbought()
    const sale = await cafe.saleDraft({
      businessDate: today,
      channelId: shopId,
      lines: [item(product.id, '1', '25')],
    })
    const purchase = await cafe.draft(purchaseInput(today, [line(material.id, '4', '9')]))
    // The purchase is held at its receipts (after its cost rows FOR UPDATE and its balances).
    await interleaved(
      'purchase then sale',
      (sql) => sql`select id from app.purchase_lines where purchase_id = ${purchase.id} for update`,
      [
        (i) => callAs(cafe, i, 'purchase.post', { id: purchase.id, version: purchase.version }),
        (i) => callAs(cafe, i, 'sale.post', { id: sale.id, version: sale.version }),
      ],
    )
    const [frozen] = await cafe.frozen(sale.id)
    expect(frozen).toMatchObject({ cost: '2.25' })
    expect(await costsOf(sale.id)).toEqual([{ cost: '2.25', timeCost: null, unpriced: 0 }])
    await expectConsistent()
  }, 60_000)

  it('two purchases filling two materials of one line: the second sees the first and gives the line its cost (lock 6)', async () => {
    const a = await cafe.material()
    const b = await cafe.material()
    const product = await cafe.product({ name: `Duo ${tag()}`, defaultPrice: '30' })
    await cafe.recipe(product.id, [
      { id: newId(), materialId: a.id, qty: '100', unit: 'ml' },
      { id: newId(), materialId: b.id, qty: '200', unit: 'ml' },
    ])
    const sale = await cafe.sell({
      businessDate: today,
      channelId: shopId,
      lines: [item(product.id, '1', '30')],
    })
    expect(await costsOf(sale.id)).toEqual([{ cost: null, timeCost: null, unpriced: 2 }])
    const buyA = await cafe.draft(purchaseInput(today, [line(a.id, '2', '5')]))
    const buyB = await cafe.draft(purchaseInput(today, [line(b.id, '2', '8')]))
    // The first fill holds the line (lock 6) and waits at a's row; the second waits for the line.
    await interleaved(
      'two fills of one line',
      (sql) => sql`
        select id from app.sale_line_materials
         where sale_id = ${sale.id} and material_id = ${a.id} for update`,
      [
        (i) => callAs(cafe, i, 'purchase.post', { id: buyA.id, version: buyA.version }),
        (i) => callAs(cafe, i, 'purchase.post', { id: buyB.id, version: buyB.version }),
      ],
    )
    // 100 ml at 5 a litre + 200 ml at 8 a litre = 0.5 + 1.6.
    expect(await costsOf(sale.id)).toEqual([{ cost: '2.1', timeCost: null, unpriced: 0 }])
    await expectConsistent()
  }, 60_000)

  it('a reversal holding the sale’s header never holds up the fill of its lines', async () => {
    const { product, material } = await unbought()
    const sale = await cafe.sell({
      businessDate: today,
      channelId: shopId,
      lines: [item(product.id, '2', '25')],
    })
    const purchase = await cafe.draft(purchaseInput(today, [line(material.id, '4', '9')]))
    const holder = connectAdmin()
    try {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      const transaction = holder.begin(async (sql) => {
        await sql`select id from app.sales where id = ${sale.id} for update`
        holding()
        await released
      })
      await held
      // Posted (and the sale filled) while the header is still held.
      const posted = await Promise.race([
        callAs(cafe, 0, 'purchase.post', { id: purchase.id, version: purchase.version }),
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 20_000)),
      ])
      release()
      await transaction
      expect(posted === 'waited' ? posted : posted.error).toBeUndefined()
    } finally {
      await holder.end()
    }
    expect(await costsOf(sale.id)).toEqual([{ cost: '4.5', timeCost: null, unpriced: 0 }])
    ok(await cafe.run('sale.reverse', { id: sale.id }))
    expect(await costsOf(sale.id)).toEqual([{ cost: '4.5', timeCost: null, unpriced: 0 }])
  }, 60_000)

  it('the owner’s hourly rate set while a sale posts, and a sale posted while it is set (business row → sale lines)', async () => {
    const baker = await SaleScope.open(api, BAKER)
    const day = await baker.today()
    const cake = await baker.product({
      name: `Cake ${tag()}`,
      defaultPrice: '60',
      ownerMinutes: '30',
    })
    const sell = (qty: string) =>
      baker.saleDraft({ businessDate: day, lines: [item(cake.id, qty, '60')] })
    const timeOf = async (id: string) => (await baker.sale(id)).lines[0]?.timeCost ?? null

    // The rate set while a sale posts: the sale holds the business row FOR SHARE (no rate read), the
    // update waits for it, then fills it.
    const first = await sell('2')
    await interleaved(
      'rate while a sale posts',
      (sql) => sql`select id from app.sale_lines where sale_id = ${first.id} for update`,
      [
        (i) => callAs(baker, i, 'sale.post', { id: first.id, version: first.version }),
        (i) => callAs(baker, i, 'productCost.updateSettings', { ownerHourlyRate: '40' }),
      ],
    )
    expect(await timeOf(first.id)).toBe('40') // 60 minutes at 40 an hour

    // A sale posted while the rate is set: the update holds the business row and waits at a line it
    // fills; the sale waits for it, then reads the new rate.
    await baker.settings({ ownerHourlyRate: null })
    const waiting = await baker.sell({ businessDate: day, lines: [item(cake.id, '1', '60')] })
    expect(await timeOf(waiting.id)).toBeNull()
    const second = await sell('3')
    await interleaved(
      'a sale while the rate is set',
      (sql) =>
        sql`select id from app.sale_lines where sale_id = ${waiting.id} and kind = 'item' for update`,
      [
        (i) => callAs(baker, i, 'productCost.updateSettings', { ownerHourlyRate: '50' }),
        (i) => callAs(baker, i, 'sale.post', { id: second.id, version: second.version }),
      ],
    )
    expect(await timeOf(waiting.id)).toBe('25') // 30 minutes at 50, filled by the update
    expect(await timeOf(second.id)).toBe('75') // 90 minutes at 50, read at posting
  }, 90_000)
})
