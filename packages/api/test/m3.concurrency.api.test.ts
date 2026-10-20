import { createHash } from 'node:crypto'
import type {
  CreditNoteDto,
  InvoiceDto,
  OrderDto,
  PurchaseDto,
  SaleDto,
  SaleImportDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CallResult } from './helpers'
import { InvoiceScope, InvoicesApi, typed } from './invoices'
import { ledgerDrift } from './ledger'
import { orderItem } from './orders'
import { tag } from './product-costs'
import { line, ok, purchaseInput } from './purchasing'
import { deadlocks, outcomesOf, Races } from './races'
import { CAFE, item, shift } from './sales'
import { BAKER } from './settings'

// Sales & Profit at the same moment (ROADMAP.md M3 Step 10 "Concurrency"; the lock orders of D-228,
// D-260, D-265, D-304, D-313): calls spread over API instances, each with its own database connection,
// so they really run together (races.ts). Each race is built so that a stale version never arises: a
// CONFLICT could only be a deadlock (both come back as CONFLICT), so none is allowed, and the
// database's own deadlock count stays the same. Each outcome is one a serial order would give:
//   - an order delivered, paid twice and cancelled at once: it is either delivered (its one sale
//     posted) or cancelled (no sale), never both; what was paid never passes its total, and once it is
//     cancelled nothing more is paid;
//   - Undo delivery against a refund and a payment: never a reversed sale with a refund standing;
//   - a sale they pay later reversed while it is paid: never a reversed sale with a payment standing;
//   - imports finalized, and one replacing a day, while the first purchases of their materials post:
//     every imported line ends priced (none missed), the replaced day's sale reversed once;
//   - sales reversed while the purchase that fills them posts: every row filled, the reversed too;
//   - invoices and credit notes issued at once by members on five instances, each sent twice on two
//     instances, with refused issues and drafts discarded while issued: one gapless series each,
//     every number once, none taken by a replay, a refusal or a discarded draft.

const INSTANCES = 5

const api = new InvoicesApi()
afterAll(() => api.close())

/** A race's calls, each named, on their instances. */
interface Call {
  readonly what: string
  readonly run: () => Promise<CallResult<unknown>>
}

/** Runs `calls` all at once; returns each one's outcome (`ok` or its app code), by name. */
async function race(calls: readonly Call[]): Promise<{ what: string; outcome: string }[]> {
  const results = await Promise.all(calls.map((c) => c.run()))
  return outcomesOf(results).map((outcome, i) => ({ what: calls[i]!.what, outcome }))
}

/** No deadlock happened since `before` (the instances' connections closed first, so their counts are in). */
async function expectNoDeadlock(races: Races, before: number) {
  await races.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(await deadlocks(api.admin)).toBe(before)
}

/** Every material row still without a price has no purchase standing of its material (none missed). */
async function expectNoneMissed(businessId: string) {
  const missed = await api.admin<{ sale_id: string; material_id: string }[]>`
    select m.sale_id, m.material_id
      from app.sale_line_materials m
      join app.sales s on s.business_id = m.business_id and s.id = m.sale_id
     where m.business_id = ${businessId} and m.cost is null and s.status <> 'draft'
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
     where l.business_id = ${businessId} and s.status <> 'draft' and l.kind = 'item'
       and l.cost_basis = 'recipe'
       and l.cost is distinct from (
         select case when bool_and(m.cost is not null) then sum(m.cost) end
           from app.sale_line_materials m
          where m.business_id = l.business_id and m.sale_line_id = l.id and m.deleted_at is null)`
  expect(wrongLines).toEqual([])
  expect(await ledgerDrift(api.admin, businessId)).toEqual([])
}

// ---------------------------------------------------------------------------------------------------
// Orders: deliver vs payment vs cancel; Undo delivery vs a refund vs a payment (D-265)
// ---------------------------------------------------------------------------------------------------

describe('an order delivered, paid and cancelled at once (D-265)', () => {
  let baker: InvoiceScope
  let today: string
  let cakeId: string
  let customerId: string

  beforeAll(async () => {
    baker = await InvoiceScope.open(api, BAKER)
    today = await baker.today()
    cakeId = (await baker.product({ name: `Cake ${tag()}`, defaultPrice: '150' })).id
    customerId = (await baker.customer()).id
  }, 60_000)

  /** `count` pending orders of a cake at 150. */
  async function orders(count: number): Promise<OrderDto[]> {
    const list: OrderDto[] = []
    for (let i = 0; i < count; i++) {
      list.push(await baker.order({ customerId, lines: [orderItem(cakeId, '1', '150')] }))
    }
    return list
  }

  const pay = (orderId: string, amount: string, kind: 'payment' | 'refund' = 'payment') => ({
    id: newId(),
    orderId,
    businessDate: today,
    method: 'cash',
    amount,
    ...(kind === 'refund' ? { kind } : {}),
  })

  it('12 orders, each delivered, paid 50 and 120 and cancelled at once: delivered or cancelled, never both; never paid past 150', async () => {
    const list = await orders(12)
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const outcomes = await race(
      list.flatMap((o, k) => [
        {
          what: `deliver ${k}`,
          run: () => races.call(baker, k, 'order.deliver', { id: o.id, version: o.version }),
        },
        {
          what: `cancel ${k}`,
          run: () =>
            races.call(baker, k + 1, 'order.cancel', {
              id: o.id,
              version: o.version,
              reason: 'Changed their mind',
            }),
        },
        {
          what: `pay 50 ${k}`,
          run: () => races.call(baker, k + 2, 'customerPayment.record', pay(o.id, '50')),
        },
        {
          what: `pay 120 ${k}`,
          run: () => races.call(baker, k + 3, 'customerPayment.record', pay(o.id, '120')),
        },
      ]),
    )
    await expectNoDeadlock(races, before)

    // Each refusal is a rule a serial order gives: never CONFLICT (a deadlock), never INTERNAL.
    const allowed: Record<string, string[]> = {
      deliver: ['ok', 'order_cancelled'],
      cancel: ['ok', 'document_posted'],
      pay: ['ok', 'order_cancelled', 'exceeds_outstanding'],
    }
    for (const { what, outcome } of outcomes) {
      expect(allowed[what.split(' ')[0]!], `${what}: ${outcome}`).toContain(outcome)
    }
    for (const [k, o] of list.entries()) {
      const of = (what: string) => outcomes.find((x) => x.what === `${what} ${k}`)!.outcome
      // Exactly one of the delivery and the cancel.
      expect([of('deliver'), of('cancel')].filter((x) => x === 'ok')).toHaveLength(1)
      const [state] = await api.admin<
        { status: string; sales: number; sold: string | null; paid: string; payments: number }[]
      >`
        select o.status,
               (select count(*)::int from app.sales s
                 where s.business_id = o.business_id and s.order_id = o.id and s.refund_of_id is null
                   and s.status = 'posted') as sales,
               (select trim_scale(sum(s.total))::text from app.sales s
                 where s.business_id = o.business_id and s.order_id = o.id and s.refund_of_id is null
                   and s.status = 'posted') as sold,
               coalesce((select trim_scale(sum(p.amount))::text from app.customer_payments p
                 where p.business_id = o.business_id and p.order_id = o.id and p.reversed_at is null
                   and p.kind = 'payment'), '0') as paid,
               (select count(*)::int from app.customer_payments p
                 where p.business_id = o.business_id and p.order_id = o.id) as payments
          from app.orders o where o.id = ${o.id}`
      const paid = ['50', '120'].filter((a) => of(`pay ${a}`) === 'ok')
      expect(state!.payments).toBe(paid.length)
      expect(Number(state!.paid)).toBeLessThanOrEqual(150)
      expect(state!.paid).toBe(String(paid.reduce((sum, a) => sum + Number(a), 0)))
      if (of('deliver') === 'ok') {
        expect(state).toMatchObject({ status: 'delivered', sales: 1, sold: '150' })
      } else {
        expect(state).toMatchObject({ status: 'cancelled', sales: 0, sold: null })
      }
    }
  }, 180_000)

  it('10 delivered orders, each undone, refunded 20 and paid 50 at once: never a reversed sale with a refund standing', async () => {
    const list: OrderDto[] = []
    for (const o of await orders(10)) list.push(await baker.deliver(o))
    const lineOf = new Map<string, string>()
    for (const o of list) {
      const sale = await baker.sale(o.saleId!)
      lineOf.set(o.id, sale.lines.find((l) => l.kind === 'item')!.id)
    }
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const outcomes = await race(
      list.flatMap((o, k) => [
        {
          what: `undo ${k}`,
          run: () => races.call(baker, k, 'order.undoDelivery', { id: o.id }),
        },
        {
          what: `refund ${k}`,
          run: () =>
            races.call(baker, k + 1, 'sale.refund', {
              id: newId(),
              orderId: o.id,
              by: 'amount',
              businessDate: today,
              lines: [{ lineId: lineOf.get(o.id)!, amount: '20' }],
              notes: 'The cake was damaged',
            }),
        },
        {
          what: `pay ${k}`,
          run: () => races.call(baker, k + 2, 'customerPayment.record', pay(o.id, '50')),
        },
      ]),
    )
    await expectNoDeadlock(races, before)

    const allowed: Record<string, string[]> = {
      undo: ['ok', 'sale_has_refunds'],
      refund: ['ok', 'document_not_posted'],
      pay: ['ok'],
    }
    for (const { what, outcome } of outcomes) {
      expect(allowed[what.split(' ')[0]!], `${what}: ${outcome}`).toContain(outcome)
    }
    for (const [k, o] of list.entries()) {
      const of = (what: string) => outcomes.find((x) => x.what === `${what} ${k}`)!.outcome
      expect([of('undo'), of('refund')].filter((x) => x === 'ok')).toHaveLength(1)
      const [state] = await api.admin<{ status: string; sale: string; refunds: number }[]>`
        select o.status,
               (select s.status from app.sales s where s.id = ${o.saleId!}) as sale,
               (select count(*)::int from app.sales r
                 where r.business_id = o.business_id and r.refund_of_id = ${o.saleId!}
                   and r.status = 'posted') as refunds
          from app.orders o where o.id = ${o.id}`
      expect(state).toEqual(
        of('undo') === 'ok'
          ? { status: 'pending', sale: 'reversed', refunds: 0 }
          : { status: 'delivered', sale: 'posted', refunds: 1 },
      )
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------
// A sale they pay later reversed while it is paid (D-265: the sale is locked first by both)
// ---------------------------------------------------------------------------------------------------

describe('a sale they pay later, reversed while it is paid', () => {
  it('12 sales, each reversed and paid twice at once: never a reversed sale with a payment standing', async () => {
    const shop = await InvoiceScope.open(api, BAKER)
    const today = await shop.today()
    const box = await shop.product({ name: `Cookie box ${tag()}`, defaultPrice: '100' })
    const customerId = (await shop.customer()).id
    const sales: SaleDto[] = []
    for (let i = 0; i < 12; i++) {
      sales.push(
        await shop.sell({
          businessDate: today,
          customerId,
          payLater: true,
          lines: [item(box.id, '1', '100')],
        }),
      )
    }
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const payment = (saleId: string, amount: string) => ({
      id: newId(),
      saleId,
      businessDate: today,
      method: 'bank_transfer',
      amount,
    })
    const outcomes = await race(
      sales.flatMap((s, k) => [
        { what: `reverse ${k}`, run: () => races.call(shop, k, 'sale.reverse', { id: s.id }) },
        {
          what: `pay ${k} a`,
          run: () => races.call(shop, k + 1, 'customerPayment.record', payment(s.id, '60')),
        },
        {
          what: `pay ${k} b`,
          run: () => races.call(shop, k + 2, 'customerPayment.record', payment(s.id, '60')),
        },
      ]),
    )
    await expectNoDeadlock(races, before)

    const allowed: Record<string, string[]> = {
      reverse: ['ok', 'sale_has_payments'],
      pay: ['ok', 'document_not_posted', 'exceeds_outstanding'],
    }
    for (const { what, outcome } of outcomes) {
      expect(allowed[what.split(' ')[0]!], `${what}: ${outcome}`).toContain(outcome)
    }
    for (const [k, s] of sales.entries()) {
      const of = (what: string) => outcomes.find((x) => x.what === `${what} ${k}`)!.outcome
      const [state] = await api.admin<{ status: string; standing: number; paid: string }[]>`
        select s.status,
               (select count(*)::int from app.customer_payments p
                 where p.business_id = s.business_id and p.sale_id = s.id and p.reversed_at is null)
                 as standing,
               coalesce((select trim_scale(sum(p.amount))::text from app.customer_payments p
                 where p.business_id = s.business_id and p.sale_id = s.id and p.reversed_at is null),
                 '0') as paid
          from app.sales s where s.id = ${s.id}`
      const paid = [`${k} a`, `${k} b`]
        .map((n) => outcomes.find((x) => x.what === `pay ${n}`)!.outcome)
        .filter((x) => x === 'ok').length
      // 60 + 60 is past the 100 owed: at most one of them stands.
      expect(paid).toBeLessThanOrEqual(1)
      if (of('reverse') === 'ok') {
        expect(state).toEqual({ status: 'reversed', standing: 0, paid: '0' })
      } else {
        expect(state).toEqual({ status: 'posted', standing: 1, paid: '60' })
      }
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------
// Imports (and a replaced day) while purchases fill their missing costs (D-260, D-229, D-236)
// ---------------------------------------------------------------------------------------------------

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

const LINES_MAPPING = {
  headerRow: 0,
  columns: { date: 0, name: 1, qty: 2, net: 3 },
  headers: { date: 'Date', name: 'Item', qty: 'Qty', net: 'Net sales' },
  dateOrder: 'dmy',
} as const

/** A draft import of a line file: `rows` of (day, product name, qty, net), every row sent. */
async function importDraft(
  scope: InvoiceScope,
  channelId: string,
  rows: readonly { day: string; name: string; qty: string; net: string }[],
): Promise<SaleImportDto> {
  const days = rows.map((r) => r.day).sort()
  const id = newId()
  ok(
    await scope.run('saleImport.create', {
      id,
      channelId,
      fileName: 'pos.csv',
      fileHash: hashOf(`file ${tag()}`),
      fingerprint: hashOf('race layout'),
      shape: 'lines',
      periodFrom: days[0],
      periodTo: days.at(-1),
      mapping: LINES_MAPPING,
      amountsIncludeVat: false,
      rowsRead: rows.length,
      rowsLeftOut: 0,
      errors: [],
      feesTotal: null,
      rowCount: rows.length,
    }),
  )
  ok(
    await scope.run('saleImport.addRows', {
      id,
      rows: rows.map((r, position) => ({
        position,
        businessDate: r.day,
        name: r.name,
        code: null,
        qty: r.qty,
        amount: r.net,
        refunds: '0',
        fileRows: 1,
      })),
    }),
  )
  return ok(await scope.run<{ data: SaleImportDto }>('saleImport.get', { id })).data
}

describe('imports finalized, and a day replaced, while purchases fill their missing costs', () => {
  let cafe: InvoiceScope
  let today: string
  let shop: string

  beforeAll(async () => {
    cafe = await InvoiceScope.open(api, CAFE)
    today = await cafe.today()
    shop = await cafe.channelId()
  }, 60_000)

  /** A product made of 100 ml of each of `count` materials never bought. */
  async function unbought(count: number) {
    const materials = []
    for (let i = 0; i < count; i++) materials.push(await cafe.material())
    const product = await cafe.product({ name: `Drink ${tag()}`, defaultPrice: '20' })
    await cafe.recipe(
      product.id,
      materials.map((m) => ({ id: newId(), materialId: m.id, qty: '100', unit: 'ml' })),
    )
    return { product, materials }
  }

  it('3 imports and the first purchases of their materials at once: every imported line priced, none missed', async () => {
    const a = await unbought(2)
    const b = await unbought(2)
    // Three files of different days, each selling both drinks (the same channel and branch: they
    // finalize one after the other, D-260, and each against the purchases).
    const drafts: SaleImportDto[] = []
    for (const back of [6, 5, 4]) {
      const day = shift(today, -back)
      drafts.push(
        await importDraft(cafe, shop, [
          { day, name: a.product.name, qty: '10', net: '200' },
          { day, name: b.product.name, qty: '5', net: '100' },
        ]),
      )
    }
    for (const draft of drafts)
      expect(draft.names.every((n) => n.match.state === 'matched')).toBe(true)
    const purchases: PurchaseDto[] = []
    for (const materials of [a.materials, b.materials]) {
      for (const m of materials) {
        purchases.push(await cafe.draft(purchaseInput(shift(today, -8), [line(m.id, '4', '9')])))
      }
    }
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const outcomes = await race([
      ...drafts.map((d, k) => ({
        what: `import ${k}`,
        run: () => races.call(cafe, k, 'saleImport.post', { id: d.id, version: d.version }),
      })),
      ...purchases.map((p, k) => ({
        what: `purchase ${k}`,
        run: () => races.call(cafe, k + 1, 'purchase.post', { id: p.id, version: p.version }),
      })),
    ])
    await expectNoDeadlock(races, before)
    expect(outcomes.filter((o) => o.outcome !== 'ok')).toEqual([])
    await expectNoneMissed(cafe.id)
    // Every imported line is priced: 100 ml of each of two materials at 9 a litre, 1.80 a drink.
    const [priced] = await api.admin<{ lines: number; unpriced: number; per_unit: string[] }[]>`
      select count(*)::int as lines, count(*) filter (where l.cost is null)::int as unpriced,
             array_agg(distinct trim_scale(l.cost / l.qty)::text) as per_unit
        from app.sale_lines l join app.sales s on s.id = l.sale_id
       where s.business_id = ${cafe.id} and s.import_id = any(${`{${drafts.map((d) => d.id).join(',')}}`}::uuid[])
         and l.kind = 'item'`
    expect(priced).toEqual({ lines: 6, unpriced: 0, per_unit: ['1.8'] })
  }, 180_000)

  it('a file replacing a day of an earlier one, while the purchase that prices both posts: replaced once, every line priced', async () => {
    const c = await unbought(1)
    const d1 = shift(today, -3)
    const d2 = shift(today, -2)
    const first = await importDraft(cafe, shop, [
      { day: d1, name: c.product.name, qty: '4', net: '80' },
      { day: d2, name: c.product.name, qty: '6', net: '120' },
    ])
    ok(await cafe.run('saleImport.post', { id: first.id, version: first.version }))
    // The second file has d2 again, corrected: it replaces that day.
    let second = await importDraft(cafe, shop, [
      { day: d2, name: c.product.name, qty: '7', net: '140' },
    ])
    ok(
      await cafe.run('saleImport.setOverlap', {
        id: second.id,
        version: second.version,
        overlap: 'replace',
      }),
    )
    second = ok(await cafe.run<{ data: SaleImportDto }>('saleImport.get', { id: second.id })).data
    const purchase = await cafe.draft(
      purchaseInput(shift(today, -8), [line(c.materials[0]!.id, '2', '5')]),
    )

    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const outcomes = await race([
      {
        what: 'replace',
        run: () =>
          races.call(cafe, 0, 'saleImport.post', { id: second.id, version: second.version }),
      },
      {
        what: 'purchase',
        run: () =>
          races.call(cafe, 1, 'purchase.post', { id: purchase.id, version: purchase.version }),
      },
    ])
    await expectNoDeadlock(races, before)
    expect(outcomes.filter((o) => o.outcome !== 'ok')).toEqual([])
    await expectNoneMissed(cafe.id)
    const sales = await api.admin<
      { import_id: string; day: string; status: string; cost: string | null }[]
    >`
      select s.import_id, s.business_date::text as day, s.status, trim_scale(l.cost)::text as cost
        from app.sales s join app.sale_lines l on l.sale_id = s.id and l.kind = 'item'
       where s.business_id = ${cafe.id} and s.import_id in (${first.id}, ${second.id})
       order by s.business_date, s.status`
    // 100 ml at 5 a litre, 0.50 a drink, on every line, the replaced one too (a fill also completes a
    // reversed sale, Q5).
    expect(sales).toEqual([
      { import_id: first.id, day: d1, status: 'posted', cost: '2' },
      { import_id: second.id, day: d2, status: 'posted', cost: '3.5' },
      { import_id: first.id, day: d2, status: 'reversed', cost: '3' },
    ])
  }, 180_000)

  // The two edges, forced (the races above overlap by chance): an import that has read the purchases
  // and holds its cost rows FOR SHARE makes the purchase wait, which then fills it; a purchase holding
  // the cost rows FOR UPDATE makes the import wait, which then reads it.
  it('a purchase posted while an import has read the purchases waits for it and fills its lines', async () => {
    const f = await unbought(1)
    const day = shift(today, -1)
    const draft = await importDraft(cafe, shop, [
      { day, name: f.product.name, qty: '3', net: '60' },
    ])
    const purchase = await cafe.draft(
      purchaseInput(shift(today, -8), [line(f.materials[0]!.id, '1', '8')]),
    )
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    // The import is held at its last step, clearing its staged rows: its sales are written and its
    // materials' cost rows held FOR SHARE.
    await races.interleaved(
      'import then purchase',
      (sql) => sql`select id from app.sale_import_rows where import_id = ${draft.id} for update`,
      [
        (i) => races.call(cafe, i, 'saleImport.post', { id: draft.id, version: draft.version }),
        (i) => races.call(cafe, i, 'purchase.post', { id: purchase.id, version: purchase.version }),
      ],
    )
    await expectNoDeadlock(races, before)
    await expectNoneMissed(cafe.id)
    const [sold] = await api.admin<{ cost: string | null; filled: number }[]>`
      select trim_scale(l.cost)::text as cost,
             (select count(*)::int from app.audit_log a
               where a.business_id = m.business_id and a.entity = 'sale_line_materials'
                 and a.entity_id = m.id and a.action = 'update') as filled
        from app.sales s join app.sale_lines l on l.sale_id = s.id
        join app.sale_line_materials m on m.sale_line_id = l.id
       where s.business_id = ${cafe.id} and s.import_id = ${draft.id}`
    // 3 × 100 ml at 8 a litre, filled by the purchase once the import committed (its row updated once).
    expect(sold).toEqual({ cost: '2.4', filled: 1 })
  }, 120_000)

  it('an import finalized while a purchase holds its materials’ cost rows waits for it and reads it', async () => {
    const g = await unbought(1)
    const day = today
    const draft = await importDraft(cafe, shop, [
      { day, name: g.product.name, qty: '2', net: '40' },
    ])
    const purchase = await cafe.draft(
      purchaseInput(shift(today, -8), [line(g.materials[0]!.id, '1', '7')]),
    )
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    // The purchase is held at its receipts (after its cost rows FOR UPDATE).
    await races.interleaved(
      'purchase then import',
      (sql) => sql`select id from app.purchase_lines where purchase_id = ${purchase.id} for update`,
      [
        (i) => races.call(cafe, i, 'purchase.post', { id: purchase.id, version: purchase.version }),
        (i) => races.call(cafe, i, 'saleImport.post', { id: draft.id, version: draft.version }),
      ],
    )
    await expectNoDeadlock(races, before)
    await expectNoneMissed(cafe.id)
    const [sold] = await api.admin<{ cost: string | null; filled: number }[]>`
      select trim_scale(l.cost)::text as cost,
             (select count(*)::int from app.audit_log a
               where a.business_id = m.business_id and a.entity = 'sale_line_materials'
                 and a.entity_id = m.id and a.action = 'update') as filled
        from app.sales s join app.sale_lines l on l.sale_id = s.id
        join app.sale_line_materials m on m.sale_line_id = l.id
       where s.business_id = ${cafe.id} and s.import_id = ${draft.id}`
    // 2 × 100 ml at 7 a litre, read at finalizing from the purchase it waited for (written priced).
    expect(sold).toEqual({ cost: '1.4', filled: 0 })
  }, 120_000)

  it('10 sales reversed while the purchase that fills them posts: every row filled, the reversed too', async () => {
    const e = await unbought(1)
    const sold: SaleDto[] = []
    for (let i = 0; i < 10; i++) {
      sold.push(
        await cafe.sell({
          businessDate: today,
          channelId: shop,
          lines: [item(e.product.id, '1', '20')],
        }),
      )
    }
    const purchase = await cafe.draft(purchaseInput(today, [line(e.materials[0]!.id, '3', '6')]))
    const races = new Races(api.admin, INSTANCES)
    const before = await deadlocks(api.admin)
    const outcomes = await race([
      ...sold
        .filter((_, k) => k % 2 === 0)
        .map((s, k) => ({
          what: `reverse ${k}`,
          run: () => races.call(cafe, k, 'sale.reverse', { id: s.id }),
        })),
      {
        what: 'purchase',
        run: () =>
          races.call(cafe, 2, 'purchase.post', { id: purchase.id, version: purchase.version }),
      },
    ])
    await expectNoDeadlock(races, before)
    expect(outcomes.filter((o) => o.outcome !== 'ok')).toEqual([])
    await expectNoneMissed(cafe.id)
    const rows = await api.admin<{ status: string; cost: string | null }[]>`
      select s.status, trim_scale(l.cost)::text as cost
        from app.sales s join app.sale_lines l on l.sale_id = s.id
       where s.id = any(${`{${sold.map((s) => s.id).join(',')}}`}::uuid[])`
    expect(rows.filter((r) => r.status === 'reversed')).toHaveLength(5)
    // 100 ml at 6 a litre on every line, posted or reversed.
    expect(rows.every((r) => r.cost === '0.6')).toBe(true)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------
// Invoice and credit note numbers under real contention and replays (D-304, D-313)
// ---------------------------------------------------------------------------------------------------

describe('invoice and credit note numbers under real contention', () => {
  const series = (prefix: string, from: number, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(from + i).padStart(4, '0')}`)

  it('invoices, credit notes, replays, refusals and discards on five instances at once: one gapless series each', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customerId = (await scope.buyer()).id
    // A registered customer without an address: a tax invoice is refused for it (DETAILS_MISSING).
    const noAddress = (await scope.customer({ kind: 'business', trn: '100555666700003' })).id
    const members = [scope.owner]
    for (let i = 0; i < 4; i++) members.push(await api.member(scope, 'manager'))

    // Round 1: 30 invoices of five members, each issue sent twice on two instances; 5 refused; 5
    // drafts discarded while their issue runs.
    const drafts: { person: (typeof members)[number]; draft: InvoiceDto }[] = []
    for (let i = 0; i < 30; i++) {
      const person = members[i % members.length]!
      drafts.push({
        person,
        draft: await scope.invoice(
          { customerId, lines: [typed(`Panel ${i}`, '1', '100')] },
          person,
        ),
      })
    }
    const refused: InvoiceDto[] = []
    for (let i = 0; i < 5; i++) {
      refused.push(
        await scope.invoice({ customerId: noAddress, lines: [typed(`Shelf ${i}`, '1', '80')] }),
      )
    }
    const discarded: InvoiceDto[] = []
    for (let i = 0; i < 5; i++) {
      discarded.push(await scope.invoice({ customerId, lines: [typed(`Door ${i}`, '1', '50')] }))
    }
    let races = new Races(api.admin, INSTANCES)
    let before = await deadlocks(api.admin)
    const issue = (d: { id: string; version: number }) => ({ id: d.id, version: d.version })
    const round1 = await Promise.all([
      ...drafts.flatMap(({ person, draft }, k) => [
        races.call<InvoiceDto>(scope, k, 'invoice.issue', issue(draft), person),
        races.call<InvoiceDto>(scope, k + 2, 'invoice.issue', issue(draft), person),
      ]),
      ...refused.map((d, k) => races.call<InvoiceDto>(scope, k, 'invoice.issue', issue(d))),
      ...discarded.flatMap((d, k) => [
        races.call<InvoiceDto>(scope, k + 1, 'invoice.issue', issue(d)),
        races.call(scope, k + 3, 'invoice.discard', issue(d)),
      ]),
    ])
    await expectNoDeadlock(races, before)
    const answers = round1.slice(0, 60) as CallResult<InvoiceDto>[]
    for (const result of answers) expect(result.error, result.raw).toBeUndefined()
    for (let i = 0; i < 30; i++) {
      // The two answers of one draft carry one number.
      expect(answers[2 * i]!.data!.number).toBe(answers[2 * i + 1]!.data!.number)
    }
    expect(outcomesOf(round1.slice(60, 65))).toEqual(Array(5).fill('details_missing'))
    // Each discard raced its issue: one of them won.
    const pairs = round1.slice(65) as CallResult<InvoiceDto>[]
    const discardIssued: string[] = []
    for (let k = 0; k < 5; k++) {
      const [issued, gone] = outcomesOf([pairs[2 * k]!, pairs[2 * k + 1]!])
      expect([issued, gone].sort()).toEqual(
        issued === 'ok' ? ['document_posted', 'ok'] : ['not_found', 'ok'],
      )
      if (issued === 'ok') discardIssued.push(pairs[2 * k]!.data!.number!)
    }
    const issuedCount = 30 + discardIssued.length
    const numbers = [
      ...answers.filter((_, i) => i % 2 === 0).map((r) => r.data!.number!),
      ...discardIssued,
    ]
    expect(numbers.sort()).toEqual(series('INV-', 1, issuedCount))

    // Round 2: 15 credit notes of the issued invoices and 10 new invoices at once, each sent twice.
    const invoices = answers.filter((_, i) => i % 2 === 0).map((r) => r.data!)
    const notes: CreditNoteDto[] = []
    for (let i = 0; i < 15; i++) {
      notes.push(
        await scope.creditDraft(invoices[i]!.id, {
          by: 'amount',
          lines: [{ invoiceLineId: invoices[i]!.lines[0]!.id, amount: '10' }],
        }),
      )
    }
    const more: InvoiceDto[] = []
    for (let i = 0; i < 10; i++) {
      more.push(await scope.invoice({ customerId, lines: [typed(`Frame ${i}`, '1', '40')] }))
    }
    races = new Races(api.admin, INSTANCES)
    before = await deadlocks(api.admin)
    const round2 = await Promise.all([
      ...notes.flatMap((n, k) => [
        races.call<CreditNoteDto>(scope, k, 'creditNote.issue', issue(n)),
        races.call<CreditNoteDto>(scope, k + 1, 'creditNote.issue', issue(n)),
      ]),
      ...more.flatMap((d, k) => [
        races.call<InvoiceDto>(scope, k + 2, 'invoice.issue', issue(d)),
        races.call<InvoiceDto>(scope, k + 4, 'invoice.issue', issue(d)),
      ]),
    ])
    await expectNoDeadlock(races, before)
    for (const result of round2) expect(result.error, result.raw).toBeUndefined()
    const noteNumbers = round2.slice(0, 30).map((r) => (r.data as CreditNoteDto).number!)
    for (let i = 0; i < 15; i++) expect(noteNumbers[2 * i]).toBe(noteNumbers[2 * i + 1])
    expect(noteNumbers.filter((_, i) => i % 2 === 0).sort()).toEqual(series('CN-', 1, 15))
    const moreNumbers = round2.slice(30).map((r) => (r.data as InvoiceDto).number!)
    for (let i = 0; i < 10; i++) expect(moreNumbers[2 * i]).toBe(moreNumbers[2 * i + 1])
    expect(moreNumbers.filter((_, i) => i % 2 === 0).sort()).toEqual(
      series('INV-', issuedCount + 1, 10),
    )

    // The counters say the same: the next numbers follow on, and nothing is left as a draft that was
    // issued.
    const counters = await api.admin<{ series: string; next_no: number }[]>`
      select series, next_no from app.document_counters
       where business_id = ${scope.id} and series in ('invoice', 'credit_note') order by series`
    expect(counters).toEqual([
      { series: 'credit_note', next_no: 16 },
      { series: 'invoice', next_no: issuedCount + 11 },
    ])
    const next = await scope.issued({ customerId, lines: [typed('Drawer', '1', '30')] })
    expect(next.number).toBe(series('INV-', issuedCount + 11, 1)[0])
  }, 300_000)
})
