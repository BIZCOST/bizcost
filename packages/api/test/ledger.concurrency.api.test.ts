import type {
  ExpenseDto,
  LocationDto,
  MaterialDto,
  PurchaseDto,
  PurchaseReturnDto,
  SupplierDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { compareDecimal, newId, sumDecimals } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { connectApi, handlerFor, mutate, type CallResult } from './helpers'
import { ledgerDrift } from './ledger'
import { codeOf, line, ok, purchaseInput, type Handler } from './purchasing'
import { WORKSHOP } from './settings'

// Every kind of posting at once on shared materials (M2 Step 8; D-110 rule 3, D-135): the M2 definition
// of done's "parallel postings never deadlock or lose an update, and give the average of a serial
// replay by posting sequence". Four API instances, each with its own database connection (like
// separate serverless functions), run together in every round: purchases posted with the same three
// materials in four different line orders and at two locations; a return and a credit note posted
// with their lines in the opposite order; the return and the credit note of the round before reversed;
// a purchase reversed and one corrected; a purchase payment recorded and the one before reversed;
// expenses finalized and reversed and an expense payment recorded (they share the business row with
// the postings); a shared material renamed (its row, which postings lock FOR SHARE); and the books
// closed up to yesterday (the business row, which every posting locks FOR SHARE). Many rounds, each
// interleaved differently. After each round:
//   - nothing was refused: no deadlock (it would come back as CONFLICT) and no internal error;
//   - no lost update: each material's cost row and each location's balance hold exactly what the final
//     documents say (posted purchase lines less posted returns and credit notes, from the documents'
//     own snapshots, not the ledger);
//   - the projections are a serial replay of the ledger in posting order (`seq`, replayWac): averages,
//     last movements, adjustments and balances (ledgerDrift, test/ledger.ts).
// purchasing.concurrency.api.test.ts covers the races between documents of one purchase.

const INSTANCES = 4
const ROUNDS = 5
/** Line orders of the three shared materials (indexes into `materials`). */
const ORDERS = [
  [0, 1, 2],
  [2, 1, 0],
  [1, 0, 2],
  [2, 0, 1],
] as const

let api: ExpensesApi
let dbs: Db[]
let handlers: Handler[]
let shop: ExpenseScope
let today: string
let yesterday: string
let branch: string
let main: string
let supplier: SupplierDto
let categoryId: string
let materials: MaterialDto[]

beforeAll(async () => {
  api = new ExpensesApi()
  dbs = Array.from({ length: INSTANCES }, () => connectApi())
  handlers = dbs.map((db) => handlerFor(db))
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  yesterday = day.toISOString().slice(0, 10)
  materials = [await shop.material(), await shop.material(), await shop.material()]
  supplier = await shop.supplier()
  categoryId = (await shop.category()).id
  branch = ok(await shop.run<LocationDto>('location.create', { id: newId(), name: 'Branch' })).id
  main = (await shop.draft(purchaseInput(today, [line(materials[0]!.id, '1', '1')]))).locationId
}, 60_000)

afterAll(async () => {
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** A call as the owner on instance `i` (its own connection). */
function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
  return mutate<T>(handlers[i % INSTANCES]!, path, {
    token: shop.owner.token,
    businessId: shop.id,
    input,
  })
}

/** One thing a round does at once: its name (for a failure's message) and the call. */
interface Call {
  readonly what: string
  readonly run: (instance: number) => Promise<CallResult<unknown>>
}

/** What later rounds do with a purchase posted in a round. */
type Role = 'return' | 'credit' | 'reverse' | 'correct' | 'pay' | 'keep'
const ROLES: readonly Role[] = ['return', 'credit', 'reverse', 'correct', 'pay', 'keep']

/** The three materials' lines in `order`: 6 + round of each, at prices from 5. */
function linesInOrder(order: readonly number[], round: number) {
  return order.map((m) => line(materials[m]!.id, String(6 + round), `${5 + m}.${round}5`))
}

/** A draft return (1 of each line) or credit note (1 on each line), lines in the opposite order. */
async function returnDraft(purchase: PurchaseDto, kind: 'return' | 'credit_note') {
  const lines = [...purchase.lines].reverse().map((l) => ({
    id: newId(),
    purchaseLineId: l.id,
    ...(kind === 'return' ? { qty: '1' } : { amount: '1' }),
  }))
  return ok(
    await shop.run<Envelope<PurchaseReturnDto>>('purchaseReturn.create', {
      id: newId(),
      purchaseId: purchase.id,
      kind,
      businessDate: today,
      lines,
    }),
  ).data
}

/** What the final documents say each material holds at each location (their own snapshots). */
function documentTotals() {
  return api.admin<{ material_id: string; location_id: string; qty: string; value: string }[]>`
    with lines as (
      select pl.material_id, p.location_id, pl.base_qty as qty, pl.cost as value
        from app.purchase_lines pl
        join app.purchases p on p.business_id = pl.business_id and p.id = pl.purchase_id
       where p.business_id = ${shop.id} and p.status = 'posted' and pl.kind = 'material'
         and pl.deleted_at is null
      union all
      select pl.material_id, p.location_id, -coalesce(rl.base_qty, 0), -rl.cost
        from app.purchase_return_lines rl
        join app.purchase_returns r on r.business_id = rl.business_id and r.id = rl.return_id
        join app.purchase_lines pl on pl.business_id = rl.business_id and pl.id = rl.purchase_line_id
        join app.purchases p on p.business_id = pl.business_id and p.id = pl.purchase_id
       where r.business_id = ${shop.id} and r.status = 'posted' and rl.deleted_at is null
    )
    select material_id, location_id, trim_scale(sum(qty))::text as qty,
           trim_scale(sum(value))::text as value
      from lines group by material_id, location_id`
}

/** No lost update: the cost rows and balances hold what the final documents say. */
async function expectDocumentsEqualProjections(round: number) {
  const totals = await documentTotals()
  for (const material of materials) {
    const mine = totals.filter((t) => t.material_id === material.id)
    const qty = sumDecimals(mine.map((t) => t.qty))
    const value = sumDecimals(mine.map((t) => t.value))
    const row = await shop.costRow(material.id)
    const where = `round ${round}, material ${material.id}`
    expect(compareDecimal(row!.qty, qty), `${where}: qty ${row!.qty}, documents ${qty}`).toBe(0)
    expect(
      compareDecimal(row!.value, value),
      `${where}: value ${row!.value}, documents ${value}`,
    ).toBe(0)
    for (const location of [main, branch]) {
      const expected = mine.find((t) => t.location_id === location)?.qty ?? '0'
      const [balance] = await api.admin<{ qty: string }[]>`
        select trim_scale(qty)::text as qty from app.stock_balances
         where business_id = ${shop.id} and location_id = ${location} and material_id = ${material.id}`
      expect(compareDecimal(balance?.qty ?? '0', expected), `${where} at ${location}`).toBe(0)
    }
  }
}

describe('every kind of posting at once on shared materials', () => {
  it(`${ROUNDS} rounds: no deadlock, no lost update, a serial replay by posting sequence`, async () => {
    const posted: { purchase: PurchaseDto; role: Role }[][] = []
    const returnsOf = new Map<number, PurchaseReturnDto[]>()
    const paymentOf = new Map<number, string>()
    const expenseOf = new Map<number, ExpenseDto>()

    for (let round = 0; round < ROUNDS; round++) {
      // Prepared one by one: this round's drafts, and what it does with earlier documents.
      const drafts: { draft: PurchaseDto; role: Role }[] = []
      for (const [i, role] of ROLES.entries()) {
        const order = ORDERS[(round + i) % ORDERS.length]!
        const extra = {
          locationId: i % 2 === 0 ? main : branch,
          ...(role === 'pay' ? { paymentMethod: 'supplier_credit', supplierId: supplier.id } : {}),
        }
        const draft = await shop.draft(purchaseInput(today, linesInOrder(order, round), extra))
        drafts.push({ draft, role })
      }
      const before = (role: Role) => posted[round - 1]?.find((b) => b.role === role)?.purchase
      const toReturn = before('return')
      const toCredit = before('credit')
      const toReverse = before('reverse')
      const toCorrect = before('correct')
      const toPay = before('pay')
      const newReturns: PurchaseReturnDto[] = []
      if (toReturn) newReturns.push(await returnDraft(toReturn, 'return'))
      if (toCredit) newReturns.push(await returnDraft(toCredit, 'credit_note'))
      const cash = await shop.expenseDraft(shop.expenseInput(categoryId, today))
      const credit = await shop.expenseDraft(
        shop.expenseInput(categoryId, today, {
          paymentMethod: 'supplier_credit',
          supplierId: supplier.id,
        }),
      )
      const renamed = ok(
        await shop.run<MaterialDto>('material.get', {
          id: materials[round % materials.length]!.id,
        }),
      )

      const calls: Call[] = drafts.map(({ draft }, i) => ({
        what: `post purchase ${i}`,
        run: (n) => on(n, 'purchase.post', { id: draft.id, version: draft.version }),
      }))
      for (const document of newReturns) {
        calls.push({
          what: `post a ${document.kind}`,
          run: (n) => on(n, 'purchaseReturn.post', { id: document.id, version: document.version }),
        })
      }
      // The return and the credit note posted the round before: nothing later stands on their lines.
      for (const document of returnsOf.get(round - 1) ?? []) {
        calls.push({
          what: `reverse a ${document.kind}`,
          run: (n) => on(n, 'purchaseReturn.reverse', { id: document.id }),
        })
      }
      if (toReverse) {
        calls.push({
          what: 'reverse a purchase',
          run: (n) => on(n, 'purchase.reverse', { id: toReverse.id }),
        })
      }
      if (toCorrect) {
        calls.push({
          what: 'correct a purchase',
          run: (n) => on(n, 'purchase.correct', { id: toCorrect.id, newId: newId() }),
        })
      }
      if (toPay) {
        const id = newId()
        paymentOf.set(round, id)
        calls.push({
          what: 'record a purchase payment',
          run: (n) =>
            on(n, 'purchasePayment.record', {
              id,
              purchaseId: toPay.id,
              businessDate: today,
              method: 'bank_transfer',
              amount: '10',
            }),
        })
      }
      const paidBefore = paymentOf.get(round - 1)
      if (paidBefore) {
        calls.push({
          what: 'reverse a purchase payment',
          run: (n) => on(n, 'purchasePayment.reverse', { id: paidBefore }),
        })
      }
      calls.push({
        what: 'finalize an expense',
        run: async (n) => {
          const result = await on<Envelope<ExpenseDto>>(n, 'expense.post', {
            id: cash.id,
            version: cash.version,
          })
          if (result.data) expenseOf.set(round, result.data.data)
          return result
        },
      })
      calls.push({
        what: 'finalize an expense on credit, then record a payment of it',
        run: async (n) => {
          const result = await on(n, 'expense.post', { id: credit.id, version: credit.version })
          if (result.error) return result
          return on(n, 'expensePayment.record', {
            id: newId(),
            expenseId: credit.id,
            businessDate: today,
            method: 'cash',
            amount: '5',
          })
        },
      })
      const spentBefore = expenseOf.get(round - 1)
      if (spentBefore) {
        calls.push({
          what: 'reverse an expense',
          run: (n) => on(n, 'expense.reverse', { id: spentBefore.id }),
        })
      }
      calls.push({
        what: 'rename a shared material',
        run: (n) =>
          on(n, 'material.update', {
            id: renamed.id,
            version: renamed.version,
            name: `${renamed.name.replace(/ r\d+$/, '')} r${round}`,
            unit: renamed.unit,
            packs: renamed.packs,
            crossFactors: renamed.crossFactors,
          }),
      })
      calls.push({
        what: 'close the books up to yesterday',
        run: (n) => on(n, 'books.close', { closedThrough: yesterday }),
      })

      // A different interleaving each round: who starts first, and on which instance.
      const start = (round * 5) % calls.length
      const rotated = [...calls.slice(start), ...calls.slice(0, start)]
      const results = await Promise.all(
        rotated.map(async (call, i) => ({ call, result: await call.run(i + round) })),
      )
      for (const { call, result } of results) {
        expect(result.error, `round ${round}, ${call.what}: ${result.raw}`).toBeUndefined()
      }
      ok(await shop.run('books.close', { closedThrough: null }))

      const mine: { purchase: PurchaseDto; role: Role }[] = []
      for (const { draft, role } of drafts) {
        const purchase = ok(
          await shop.run<Envelope<PurchaseDto>>('purchase.get', { id: draft.id }),
        ).data
        expect(purchase.status, `round ${round}, a purchase to ${role}`).toBe('posted')
        mine.push({ purchase, role })
      }
      posted.push(mine)
      returnsOf.set(round, newReturns)

      await expectDocumentsEqualProjections(round)
      expect(await ledgerDrift(api.admin, shop.id), `round ${round}`).toEqual([])
    }

    // Each round after the first reversed one purchase and corrected another: each reversed once.
    const [counts] = await api.admin<{ reversed: number; twice: number; materials: number }[]>`
      select (select count(*)::int from app.purchases
               where business_id = ${shop.id} and status = 'reversed') as reversed,
             (select count(*)::int from (
                select reverses_id from app.stock_movements
                 where business_id = ${shop.id} and reverses_id is not null
                 group by reverses_id having count(*) > 1) d) as twice,
             (select count(distinct material_id)::int from app.stock_movements
               where business_id = ${shop.id}) as materials`
    expect(counts).toEqual({ reversed: 2 * (ROUNDS - 1), twice: 0, materials: 3 })
  }, 300_000)
})

describe('returns, credit notes and their reversals racing on the same purchase lines', () => {
  it('each outcome is one a serial order would give, and nothing is lost', async () => {
    const [a, b] = [materials[0]!, materials[1]!]
    for (let round = 0; round < 6; round++) {
      const lines =
        round % 2 === 0
          ? [line(a.id, '20', '4'), line(b.id, '20', '3')]
          : [line(b.id, '20', '3'), line(a.id, '20', '4')]
      const purchase = await shop.buy(purchaseInput(today, lines))
      const lineOf = (m: MaterialDto) => purchase.lines.find((l) => l.materialId === m.id)!.id
      const draft = async (kind: 'return' | 'credit_note', parts: [MaterialDto, string][]) =>
        ok(
          await shop.run<Envelope<PurchaseReturnDto>>('purchaseReturn.create', {
            id: newId(),
            purchaseId: purchase.id,
            kind,
            businessDate: today,
            lines: parts.map(([m, value]) => ({
              id: newId(),
              purchaseLineId: lineOf(m),
              ...(kind === 'return' ? { qty: value } : { amount: value }),
            })),
          }),
        ).data
      // Six documents on the same two lines, lines in both orders, posted at once: all fit.
      const first = [
        await draft('return', [[a, '5']]),
        await draft('credit_note', [[a, '10']]),
        await draft('return', [[b, '5']]),
        await draft('credit_note', [[b, '10']]),
        await draft('return', [
          [b, '2'],
          [a, '2'],
        ]),
        await draft('credit_note', [
          [a, '3'],
          [b, '3'],
        ]),
      ]
      const posted = await Promise.all(
        first.map((d, i) =>
          on<Envelope<PurchaseReturnDto>>(i + round, 'purchaseReturn.post', {
            id: d.id,
            version: d.version,
          }),
        ),
      )
      for (const result of posted)
        expect(result.error, `round ${round}: ${result.raw}`).toBeUndefined()

      // Then a credit note and a return reversed while another return of the same line is posted:
      // a reversal is refused once a later return of its line stands (D-142), whichever came first.
      const later = await draft('return', [[a, '1']])
      const [creditBack, posting, returnBack] = await Promise.all([
        on(round, 'purchaseReturn.reverse', { id: first[1]!.id }),
        on(round + 1, 'purchaseReturn.post', { id: later.id, version: later.version }),
        on(round + 2, 'purchaseReturn.reverse', { id: first[2]!.id }),
      ])
      expect(posting.error, `round ${round}: ${posting.raw}`).toBeUndefined()
      for (const result of [creditBack, returnBack]) {
        expect(['ok', 'has_later_returns'], `round ${round}: ${result.raw}`).toContain(
          codeOf(result) ?? 'ok',
        )
      }
      // A refusal is exactly what the ledger says: a later return of the line stood when the reversal
      // was tried (posted before the reversal's own movement, if it went through).
      const [laterReturns] = await api.admin<{ credit: number; ret: number }[]>`
        select count(*) filter (where t.return_line_id = ${first[1]!.lines[0]!.id})::int as credit,
               count(*) filter (where t.return_line_id = ${first[2]!.lines[0]!.id})::int as ret
          from app.stock_movements t
          join app.stock_movements m
            on m.business_id = t.business_id and m.receipt_id = t.receipt_id
           and m.kind = 'purchase_return' and m.seq > t.seq
         where t.business_id = ${shop.id}
           and t.return_line_id in (${first[1]!.lines[0]!.id}, ${first[2]!.lines[0]!.id})
           and t.kind in ('purchase_return', 'purchase_credit')
           and not exists (select 1 from app.stock_movements r
                            where r.business_id = m.business_id and r.reverses_id = m.id)
           and not exists (select 1 from app.stock_movements r
                            where r.business_id = t.business_id and r.reverses_id = t.id
                              and r.seq < m.seq)`
      expect(codeOf(creditBack) === 'has_later_returns', `round ${round}: credit`).toBe(
        (laterReturns?.credit ?? 0) > 0,
      )
      expect(codeOf(returnBack) === 'has_later_returns', `round ${round}: return`).toBe(
        (laterReturns?.ret ?? 0) > 0,
      )

      await expectDocumentsEqualProjections(round)
      expect(await ledgerDrift(api.admin, shop.id), `round ${round}`).toEqual([])
    }
  }, 300_000)
})
