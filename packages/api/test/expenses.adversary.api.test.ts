import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  CostCategoryDto,
  ExpenseDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { PNG, uploadTo } from './hardening/fixture'
import { addMember } from './helpers'
import { codeOf, ok, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// M2 Step 5 security and money review (adversary pass). Each test states what the rules promise
// (D-164: "a submitted or approved expense is frozen … what was sent is what is approved"; D-114
// rule 6 and D-166: the books-closed date holds for expenses too); the findings were fixed with D-176.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let yesterday: string
let category: CostCategoryDto
let clerk: Person
let manager: Person & { memberId: string }

function shift(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  yesterday = shift(today, -1)
  category = await shop.category()
  // Enters and finalizes expenses, sees their amounts, may not approve (a custom role).
  clerk = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, clerk.user, {
    template: 'employee',
    overrides: [
      { key: 'expenses.documents.view', effect: 'allow' },
      { key: 'expenses.documents.manage', effect: 'allow' },
      { key: 'expenses.documents.post', effect: 'allow' },
      { key: 'data.cost.view', effect: 'allow' },
      { key: 'data.supplier_price.view', effect: 'allow' },
    ],
  })
  manager = await api.member(shop, 'manager')
  ok(await shop.run('expense.updateSettings', { approval: true }))
}, 60_000)

afterAll(async () => {
  await api.close()
})

/**
 * Uploads a PNG receipt to the expense as `person` and attaches it: the code of the first step that
 * refuses, or the attachment.
 */
async function attachReceipt(
  person: Person,
  expenseId: string,
): Promise<{ code: string | undefined; receipt?: AttachmentDto }> {
  const upload = await shop.as<AttachmentUploadUrlDto>(person, 'attachment.uploadUrl', {
    entity: 'expense',
    entityId: expenseId,
    contentType: 'image/png',
  })
  if (upload.error) return { code: codeOf(upload) }
  expect((await uploadTo(upload.data!.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  const added = await shop.as<Envelope<AttachmentDto>>(person, 'attachment.add', {
    entity: 'expense',
    entityId: expenseId,
    path: upload.data!.path,
    fileName: 'receipt.png',
  })
  return { code: codeOf(added), receipt: added.data?.data }
}

async function clerkSubmitted(): Promise<{ sent: ExpenseDto; receipt: AttachmentDto }> {
  const draft = ok(
    await shop.as<Envelope<ExpenseDto>>(
      clerk,
      'expense.create',
      shop.expenseInput(category.id, today, { amount: '500' }),
    ),
  ).data
  const attached = await attachReceipt(clerk, draft.id)
  expect(attached.code).toBeUndefined()
  const receipt = attached.receipt!
  const sent = ok(
    await shop.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
      id: draft.id,
      version: draft.version,
    }),
  ).data
  return { sent, receipt }
}

describe('what the approver reviewed is what is approved (D-164), receipts included', () => {
  it('the receipt the approver is looking at cannot be taken off while the expense waits', async () => {
    const { sent, receipt } = await clerkSubmitted()
    // The manager opens it: one receipt, version v.
    const seen = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.get', { id: sent.id }),
    ).data
    expect(seen.attachmentCount).toBe(1)
    // The one who sent it takes the receipt off (the file is deleted from Storage). The expense is
    // "frozen" while it is reviewed, so this should be refused like expense.update / .discard are.
    const removed = await shop.as(clerk, 'attachment.remove', { id: receipt.id })
    expect(codeOf(removed)).toBe('expense_in_approval')
    // So the approval below goes through at the version the manager read with the receipt they saw.
    const approved = await shop.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
      id: seen.id,
      version: seen.version,
    })
    expect(ok(approved).data.attachmentCount).toBe(1)
  })

  it('an approved expense does not take a different receipt before it is finalized', async () => {
    const { sent } = await clerkSubmitted()
    const approved = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
        id: sent.id,
        version: sent.version,
      }),
    ).data
    expect(approved.status).toBe('approved')
    const added = await attachReceipt(clerk, approved.id)
    expect(added.code).toBe('expense_in_approval')
  })
})

describe('the books-closed date for expenses (D-114 rule 6, D-166)', () => {
  it('sending for approval refuses a day the books are closed on, as it refuses a future day', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const own = await scope.category()
    const sender = await api.person()
    await addMember(api.db, scope.owner.user, scope.id, sender.user, {
      template: 'employee',
      overrides: [
        { key: 'expenses.documents.view', effect: 'allow' },
        { key: 'expenses.documents.manage', effect: 'allow' },
        { key: 'data.cost.view', effect: 'allow' },
        { key: 'data.supplier_price.view', effect: 'allow' },
      ],
    })
    ok(await scope.run('expense.updateSettings', { approval: true }))
    const draft = ok(
      await scope.as<Envelope<ExpenseDto>>(
        sender,
        'expense.create',
        scope.expenseInput(own.id, yesterday),
      ),
    ).data
    ok(await scope.run('books.close', { closedThrough: yesterday }))
    // It could never be finalized (BOOKS_CLOSED at posting), and once sent it is frozen: the
    // approver must reject it before its day can be changed. submitExpense already refuses
    // FUTURE_DATE for this very reason.
    const sent = await scope.as(sender, 'expense.submit', { id: draft.id, version: draft.version })
    expect(codeOf(sent)).toBe('books_closed')
  })

  it('a business with Expenses and without Purchases can still close (and reopen) its books', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const own = await scope.category()
    const day = await scope.today()
    ok(await scope.run('books.close', { closedThrough: shift(day, -1) }))
    // Purchases turned off (a business that buys no materials, D-166): Expenses still honour the
    // closed date (BOOKS_CLOSED) ...
    ok(
      await scope.run('business.customize', {
        item: { kind: 'module', id: 'purchases' },
        enabled: false,
      }),
    )
    const late = await scope.expenseDraft(scope.expenseInput(own.id, shift(day, -1)))
    expect(codeOf(await scope.run('expense.post', { id: late.id, version: late.version }))).toBe(
      'books_closed',
    )
    // ... and whoever may close the books can still open or move it (Purchases or Expenses on).
    const reopened = await scope.run('books.close', { closedThrough: null })
    expect(codeOf(reopened)).toBeUndefined()
  })
})

describe('running costs count once (D-116, D-169)', () => {
  it('a rent that "stopped on" today and the new rent "paid since" today are not both counted', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const own = await scope.category()
    const day = await scope.today()
    const old = await scope.runningCost({
      id: newId(),
      name: 'Rent',
      categoryId: own.id,
      amount: '1000',
      startsOn: shift(day, -60),
    })
    // The rent changes today: the web's form says "Stopped on" (the day it stopped) for the old one,
    // and a new one is "paid since" today by default.
    ok(
      await scope.run('runningCost.update', {
        id: old.id,
        version: old.version,
        name: 'Rent',
        categoryId: own.id,
        amount: '1000',
        startsOn: shift(day, -60),
        endsOn: day,
      }),
    )
    await scope.runningCost({
      id: newId(),
      name: 'Rent',
      categoryId: own.id,
      amount: '1200',
      startsOn: day,
    })
    const listed = ok(
      await scope.run<{ data: { monthlyTotal: string; items: { state: string }[] } }>(
        'runningCost.list',
        {},
      ),
    ).data
    // "Stopped on" is the first day it no longer counts: the rent is counted once on the handover
    // day (what Step 6 shares over product costs), never 2 200.
    expect(listed.monthlyTotal).toBe('1200')
  })
})

describe('amounts at the edge of the column', () => {
  it('an amount whose total with VAT does not fit is VALIDATION, never INTERNAL', async () => {
    // 16 integer digits pass positiveMoneyInput (numeric(20,4)); with 5 % VAT the total does not
    // fit numeric(20,4) and Postgres raises 22003, which the API does not map.
    const result = await shop.run(
      'expense.create',
      shop.expenseInput(category.id, today, { amount: '9999999999999999.99', vatRate: '5' }),
    )
    expect(codeOf(result)).toBe('validation')
  })
})
