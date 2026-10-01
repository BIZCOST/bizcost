import type { ExpenseDto, PurchaseDto, PurchaseReturnDto, SupplierDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import type { CallResult } from './helpers'
import { codeOf, line, ok, purchaseInput } from './purchasing'
import { WORKSHOP } from './settings'

// The books-closed date, every document that posts (M2 Step 8; D-114 rule 6, D-135, D-200, D-201),
// through the API: purchases, supplier returns, credit notes, expenses and the payments of purchases
// and expenses. Closed through yesterday: nothing dated yesterday or before is posted, finalized or
// recorded (BOOKS_CLOSED); a reversal of a closed day is dated the first open day (today), its ledger
// movements too, and an expense's reversal counts in its own month or, once that month is closed, the
// first open month. Closed through today: nothing is reversed or corrected (its first open day would
// be tomorrow) and nothing dated today is posted. Closed through the end of last month: an expense for
// last month is not finalized though its bill is dated in the open period, and a reversal of one is
// counted in this month. Opened again, it all goes through. The database refuses the same
// (supabase/tests/19_books_closed_guard.test.sql, packages/db/test/ledger.db.test.ts).

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let yesterday: string
let twoDaysAgo: string
let lastMonthEnd: string
let supplier: SupplierDto
let categoryId: string
let milk: string

const shift = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const monthOf = (day: string) => day.slice(0, 7)

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  yesterday = shift(today, -1)
  twoDaysAgo = shift(today, -2)
  lastMonthEnd = shift(`${monthOf(today)}-01`, -1)
  supplier = await shop.supplier()
  categoryId = (await shop.category()).id
  milk = (await shop.material()).id
}, 60_000)

afterAll(async () => {
  await api.close()
})

const close = async (through: string | null) =>
  ok(await shop.run('books.close', { closedThrough: through }))

/** A posted purchase of 10 L of milk on `day` (on credit: it can be paid). */
function bought(day: string, credit = false) {
  return shop.buy(
    purchaseInput(
      day,
      [line(milk, '10', '6')],
      credit ? { paymentMethod: 'supplier_credit', supplierId: supplier.id } : {},
    ),
  )
}

/** A draft return of 1 L, or credit note of 1, on the purchase's line, dated `day`. */
function returnDraft(purchase: PurchaseDto, kind: 'return' | 'credit_note', day: string) {
  return shop.returnDraft({
    id: newId(),
    purchaseId: purchase.id,
    kind,
    businessDate: day,
    lines: [
      {
        id: newId(),
        purchaseLineId: purchase.lines[0]!.id,
        ...(kind === 'return' ? { qty: '1' } : { amount: '1' }),
      },
    ],
  })
}

function expenseDraft(day: string, extra: object = {}) {
  return shop.expenseDraft(shop.expenseInput(categoryId, day, extra))
}

const onCredit = () => ({ paymentMethod: 'supplier_credit', supplierId: supplier.id })

async function payPurchase(purchaseId: string, day: string) {
  const id = newId()
  const result = await shop.run('purchasePayment.record', {
    id,
    purchaseId,
    businessDate: day,
    method: 'cash',
    amount: '1',
  })
  return { id, result }
}

async function payExpense(expenseId: string, day: string) {
  const id = newId()
  const result = await shop.run('expensePayment.record', {
    id,
    expenseId,
    businessDate: day,
    method: 'cash',
    amount: '1',
  })
  return { id, result }
}

/** The business days of the reversal movements of a purchase's or a return's lines. */
async function reversalDays(column: 'purchase_line_id' | 'return_line_id', lineIds: string[]) {
  const rows = await api.admin<{ day: string }[]>`
    select distinct m.business_date::text as day from app.stock_movements m
     where m.business_id = ${shop.id} and m.kind = 'reversal'
       and m.${api.admin(column)} = any(${lineIds}::uuid[])`
  return rows.map((r) => r.day)
}

/** The month a reversed expense's reversal counts in (`reversal_period_month`, D-200). */
async function reversalMonth(expenseId: string) {
  const [row] = await api.admin<{ month: string | null }[]>`
    select to_char(reversal_period_month, 'YYYY-MM') as month from app.expenses where id = ${expenseId}`
  return row?.month
}

describe('the books closed through yesterday', () => {
  it('refuses posting on or before it, and dates reversals of a closed day on the first open day', async () => {
    // Entered while the books are open.
    const purchase = await bought(twoDaysAgo)
    const onCreditPurchase = await bought(twoDaysAgo, true)
    const forReturns = await bought(twoDaysAgo)
    const ret = await shop.postReturn(await returnDraft(forReturns, 'return', twoDaysAgo))
    const credit = await shop.postReturn(await returnDraft(forReturns, 'credit_note', twoDaysAgo))
    const expense = await shop.spend(shop.expenseInput(categoryId, twoDaysAgo))
    const expenseOnCredit = await shop.spend(shop.expenseInput(categoryId, twoDaysAgo, onCredit()))
    const purchasePaid = await payPurchase(onCreditPurchase.id, twoDaysAgo)
    ok(purchasePaid.result)
    const expensePaid = await payExpense(expenseOnCredit.id, twoDaysAgo)
    ok(expensePaid.result)
    const drafts = {
      purchaseOn: await shop.draft(purchaseInput(yesterday, [line(milk, '1', '6')])),
      purchaseBefore: await shop.draft(purchaseInput(twoDaysAgo, [line(milk, '1', '6')])),
      returnOn: await returnDraft(forReturns, 'return', yesterday),
      creditOn: await returnDraft(forReturns, 'credit_note', yesterday),
      expenseOn: await expenseDraft(yesterday),
    }

    await close(yesterday)

    const version = (d: { id: string; version: number }) => ({ id: d.id, version: d.version })
    const refused: [string, () => Promise<CallResult>][] = [
      [
        'a purchase dated on the closed day',
        () => shop.run('purchase.post', version(drafts.purchaseOn)),
      ],
      [
        'a purchase dated before it',
        () => shop.run('purchase.post', version(drafts.purchaseBefore)),
      ],
      ['a return dated on it', () => shop.run('purchaseReturn.post', version(drafts.returnOn))],
      [
        'a credit note dated on it',
        () => shop.run('purchaseReturn.post', version(drafts.creditOn)),
      ],
      ['an expense dated on it', () => shop.run('expense.post', version(drafts.expenseOn))],
      [
        'a payment of a purchase dated on it',
        async () => (await payPurchase(onCreditPurchase.id, yesterday)).result,
      ],
      [
        'a payment of an expense dated on it',
        async () => (await payExpense(expenseOnCredit.id, yesterday)).result,
      ],
    ]
    for (const [what, call] of refused) {
      const result = await call()
      expect(codeOf(result), `${what}: ${result.raw}`).toBe('books_closed')
    }

    // Reversals of a closed day are dated today, the first open day, and so are their movements.
    const reversed = await shop.reverse(purchase.id)
    expect(reversed.reversalDate).toBe(today)
    expect(
      await reversalDays(
        'purchase_line_id',
        purchase.lines.map((l) => l.id),
      ),
    ).toEqual([today])
    for (const document of [ret, credit]) {
      const back = ok(
        await shop.run<Envelope<PurchaseReturnDto>>('purchaseReturn.reverse', { id: document.id }),
      ).data
      expect(back.reversalDate, document.kind).toBe(today)
      expect(
        await reversalDays(
          'return_line_id',
          document.lines.map((l) => l.id),
        ),
      ).toEqual([today])
    }
    // The return reversed after the credit note: a credit note has no later return here.
    ok(await shop.run('purchasePayment.reverse', { id: purchasePaid.id }))
    ok(await shop.run('expensePayment.reverse', { id: expensePaid.id }))
    const [payments] = await api.admin<{ days: string[] }[]>`
      select array_agg(distinct reversal_date::text) as days from (
        select reversal_date from app.purchase_payments where id = ${purchasePaid.id}
        union all
        select reversal_date from app.expense_payments where id = ${expensePaid.id}) p`
    expect(payments?.days).toEqual([today])
    const back = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.reverse', { id: expense.id }),
    ).data
    expect(back.reversalDate).toBe(today)
    // It counts in its own month, unless the books are closed through that month's last day (D-200).
    const ownMonth = monthOf(twoDaysAgo)
    expect(await reversalMonth(expense.id)).toBe(
      ownMonth < monthOf(today) ? monthOf(today) : ownMonth,
    )

    await close(null)
    for (const draft of [drafts.purchaseOn, drafts.purchaseBefore]) {
      expect((await shop.post(draft)).status).toBe('posted')
    }
    await shop.expectRebuildEqualsProjections()
  })
})

describe('the books closed through today', () => {
  it('refuses every reversal and correction (the first open day would be tomorrow) and posting today', async () => {
    const purchase = await bought(today)
    const onCreditPurchase = await bought(today, true)
    const forReturns = await bought(today)
    const ret = await shop.postReturn(await returnDraft(forReturns, 'return', today))
    const forCredit = await bought(today)
    const credit = await shop.postReturn(await returnDraft(forCredit, 'credit_note', today))
    const expense = await shop.spend(shop.expenseInput(categoryId, today))
    const expenseOnCredit = await shop.spend(shop.expenseInput(categoryId, today, onCredit()))
    const purchasePaid = await payPurchase(onCreditPurchase.id, today)
    ok(purchasePaid.result)
    const expensePaid = await payExpense(expenseOnCredit.id, today)
    ok(expensePaid.result)
    const purchaseToday = await shop.draft(purchaseInput(today, [line(milk, '1', '6')]))
    const expenseToday = await expenseDraft(today)

    await close(today)

    const refused: [string, string, object][] = [
      ['reverse a purchase', 'purchase.reverse', { id: purchase.id }],
      ['correct a purchase', 'purchase.correct', { id: purchase.id, newId: newId() }],
      ['reverse a return', 'purchaseReturn.reverse', { id: ret.id }],
      ['reverse a credit note', 'purchaseReturn.reverse', { id: credit.id }],
      ['reverse an expense', 'expense.reverse', { id: expense.id }],
      ['correct an expense', 'expense.correct', { id: expense.id, newId: newId() }],
      ['reverse a payment of a purchase', 'purchasePayment.reverse', { id: purchasePaid.id }],
      ['reverse a payment of an expense', 'expensePayment.reverse', { id: expensePaid.id }],
      [
        'post a purchase dated today',
        'purchase.post',
        { id: purchaseToday.id, version: purchaseToday.version },
      ],
      [
        'finalize an expense dated today',
        'expense.post',
        { id: expenseToday.id, version: expenseToday.version },
      ],
    ]
    for (const [what, path, input] of refused) {
      const result = await shop.run(path, input)
      expect(codeOf(result), `${what}: ${result.raw}`).toBe('books_closed')
    }
    // Nothing moved.
    const [movements] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements
       where business_id = ${shop.id} and kind = 'reversal'
         and purchase_line_id = any(${[purchase.lines[0]!.id, forReturns.lines[0]!.id, forCredit.lines[0]!.id]}::uuid[])`
    expect(movements?.n).toBe(0)

    await close(null)
    expect((await shop.reverse(purchase.id)).reversalDate).toBe(today)
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.reverse', { id: expense.id })).data.status,
    ).toBe('reversed')
    await shop.expectRebuildEqualsProjections()
  })
})

describe('the books closed through the end of last month (closed months, D-200)', () => {
  it('refuses an expense for last month, and counts a reversal of one in this month', async () => {
    const forLastMonth = await expenseDraft(today, { periodMonth: monthOf(lastMonthEnd) })
    const forThisMonth = await expenseDraft(today, { periodMonth: monthOf(today) })
    const old = await shop.spend(shop.expenseInput(categoryId, lastMonthEnd))
    expect(old.periodMonth).toBe(monthOf(lastMonthEnd))

    await close(lastMonthEnd)

    const refused = await shop.run('expense.post', {
      id: forLastMonth.id,
      version: forLastMonth.version,
    })
    expect(codeOf(refused), refused.raw).toBe('books_closed')
    expect((await shop.postExpense(forThisMonth)).status).toBe('posted')
    const back = ok(await shop.run<Envelope<ExpenseDto>>('expense.reverse', { id: old.id })).data
    expect(back.reversalDate).toBe(`${monthOf(today)}-01`)
    expect(await reversalMonth(old.id)).toBe(monthOf(today))

    await close(null)
    expect((await shop.postExpense(forLastMonth)).status).toBe('posted')
  })
})
