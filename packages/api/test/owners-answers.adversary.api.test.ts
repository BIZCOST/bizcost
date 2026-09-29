import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  CostCategoryDto,
  ExpenseDto,
  MaterialDto,
  ProductDto,
  RecipeResultDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { PNG, uploadTo } from './hardening/fixture'
import { addMember } from './helpers'
import { codeOf, ok, purchaseInput, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Security and redaction review of the owner's answers of 2026-09-29 (A1–A4; D-178–D-181), the
// adversary's findings. Each test states the secure outcome and fails while the issue stands.
//
//   1. expense.getMine / expense.mine return the amounts of every expense the caller ENTERED
//      (created_by). expense.correct makes a copy of any final or reversed expense as a new draft whose
//      created_by is the caller, with the original's amounts. A member who may reverse and manage
//      expenses but may not see supplier prices (a Manager with data.supplier_price.view taken off, the
//      "blind manager" the attack suites already model) corrects anyone's expense and reads its amounts
//      through expense.getMine. For an expense already reversed the copy changes nothing else.
//   2. A3 gives every Employee expenses.documents.manage, which reaches every member's records, not
//      only the employee's own: they discard or rewrite a draft the owner entered (amounts they cannot
//      even see, e.g. to "paid by me"), and take the receipts off a final expense.
//   3. expense.mine returns `paid` and `outstanding` for every final expense on credit the caller
//      entered, not only for what they paid themselves: an Employee (no expenses.payments.view:
//      expensePayment.list and payable.list are FORBIDDEN) reads what the business paid the supplier
//      and still owes it.
//   4. A1: one unit costs total ÷ yield, and a yield may be as small as 0.000001, so perUnit is up to a
//      million times the total with 12 decimals, with no bound: a recipe whose cost shows fine with a
//      yield of 1 makes recipe.save answer INTERNAL (after storing the yield) and recipe.get and
//      product.costs fail (INTERNAL: the output is longer than a decimal may be) for every member.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let category: CostCategoryDto
let blind: Person
let employee: Person & { memberId: string }

/** A distinctive amount of the owner's (no VAT: the total is the amount). */
const OWNERS_AMOUNT = '4321.17'
const OWNERS_REVERSED = '8765.43'

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  category = await shop.category()
  blind = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, blind.user, {
    template: 'manager',
    overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
  })
  employee = await api.member(shop, 'employee')
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** An expense the owner entered and paid in cash, final. */
async function ownersExpense(amount: string): Promise<ExpenseDto> {
  return shop.spend(
    shop.expenseInput(category.id, today, { amount, vatRate: '0', description: 'Owner only' }),
  )
}

describe('1. a copy made by expense.correct is not "my own" record (A4, D-181)', () => {
  it('a member who may not see supplier prices does not read the owner’s amounts by correcting it', async () => {
    const original = await ownersExpense(OWNERS_AMOUNT)
    // The premise: the blind manager sees the owner's expense without its amounts.
    const seen = ok(await shop.as<Envelope<ExpenseDto>>(blind, 'expense.get', { id: original.id }))
    expect(seen.data.total).toBeUndefined()

    const copyId = newId()
    const corrected = await shop.as(blind, 'expense.correct', { id: original.id, newId: copyId })
    expect(corrected.raw.includes(OWNERS_AMOUNT), corrected.raw).toBe(false)
    const one = await shop.as(blind, 'expense.getMine', { id: copyId })
    expect(one.raw.includes(OWNERS_AMOUNT), `expense.getMine: ${one.raw}`).toBe(false)
    const list = await shop.as(blind, 'expense.mine', { limit: 100 })
    expect(list.raw.includes(OWNERS_AMOUNT), `expense.mine: ${list.raw}`).toBe(false)
  })

  it('nor of one already reversed, where the copy changes nothing else', async () => {
    const original = await ownersExpense(OWNERS_REVERSED)
    ok(await shop.run('expense.reverse', { id: original.id }))
    const copyId = newId()
    const corrected = await shop.as(blind, 'expense.correct', { id: original.id, newId: copyId })
    expect(corrected.raw.includes(OWNERS_REVERSED), corrected.raw).toBe(false)
    const one = await shop.as(blind, 'expense.getMine', { id: copyId })
    expect(one.raw.includes(OWNERS_REVERSED), `expense.getMine: ${one.raw}`).toBe(false)
  })
})

describe('2. an Employee enters their own expenses, not everyone’s (A3, D-180)', () => {
  it('does not discard a draft the owner entered', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(category.id, today))
    const discarded = await shop.as(employee, 'expense.discard', {
      id: draft.id,
      version: draft.version,
    })
    expect(['forbidden', 'not_found'], discarded.raw).toContain(codeOf(discarded))
  })

  it('does not rewrite a draft the owner entered into one the business owes them', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(category.id, today))
    const { id, version } = draft
    const rewritten = await shop.as(employee, 'expense.update', {
      ...shop.expenseInput(category.id, today, {
        paymentMethod: 'paid_by_member',
        paidByMemberId: employee.memberId,
        amount: '5000',
      }),
      id,
      version,
    })
    expect(['forbidden', 'not_found'], rewritten.raw).toContain(codeOf(rewritten))
  })

  it('does not take the receipt off an expense the owner finalized', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(category.id, today))
    const upload = ok(
      await shop.run<AttachmentUploadUrlDto>('attachment.uploadUrl', {
        entity: 'expense',
        entityId: draft.id,
        contentType: 'image/png',
      }),
    )
    expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    const receipt = ok(
      await shop.run<Envelope<AttachmentDto>>('attachment.add', {
        entity: 'expense',
        entityId: draft.id,
        path: upload.path,
        fileName: 'bill.png',
      }),
    ).data
    await shop.postExpense(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: draft.id })).data,
    )
    const removed = await shop.as(employee, 'attachment.remove', { id: receipt.id })
    expect(['forbidden', 'not_found'], removed.raw).toContain(codeOf(removed))
    const [row] = await api.admin<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.attachments where id = ${receipt.id}`
    expect(row?.deleted).toBe(false)
  })
})

describe('3. "My expenses" is not a way round expenses.payments.view (A4, D-181)', () => {
  it('an Employee does not learn what the business paid a supplier on an expense they entered', async () => {
    const supplier = await shop.supplier()
    const entered = ok(
      await shop.as<Envelope<ExpenseDto>>(
        employee,
        'expense.create',
        shop.expenseInput(category.id, today, {
          supplierId: supplier.id,
          paymentMethod: 'supplier_credit',
        }),
      ),
    ).data
    await shop.postExpense(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: entered.id })).data,
    )
    // The owner pays the supplier part of it: 41.37 of 105, 63.63 left.
    ok(
      await shop.run('expensePayment.record', {
        id: newId(),
        expenseId: entered.id,
        businessDate: today,
        method: 'cash',
        amount: '41.37',
      }),
    )
    // The premise: the employee may not see payments or what is owed.
    expect(codeOf(await shop.as(employee, 'expensePayment.list', { expenseId: entered.id }))).toBe(
      'forbidden',
    )
    expect(codeOf(await shop.as(employee, 'payable.list', { party: 'supplier' }))).toBe('forbidden')
    const list = await shop.as(employee, 'expense.mine', { limit: 100 })
    expect(list.raw.includes('41.37'), list.raw).toBe(false)
    expect(list.raw.includes('63.63'), list.raw).toBe(false)
  })
})

describe('4. a tiny yield does not break the cost of a product (A1, D-178)', () => {
  it('recipe.get and product.costs still answer when the yield is 0.000003', async () => {
    const milk = ok(
      await shop.run<MaterialDto>('material.create', {
        id: newId(),
        name: `Milk ${newId().slice(-10)}`,
        unit: 'l',
      }),
    )
    // 3 ml bought at 10^15 a millilitre (a line of 3 × 10^15, within a purchase's amounts).
    await shop.buy(
      purchaseInput(today, [
        {
          kind: 'material',
          id: newId(),
          materialId: milk.id,
          qty: '3',
          unit: 'ml',
          unitPrice: '1000000000000000',
        },
      ]),
    )
    const product = ok(
      await shop.run<ProductDto>('product.create', {
        id: newId(),
        name: `Product ${newId().slice(-10)}`,
        type: 'product',
        unit: 'piece',
      }),
    )
    const lines = [{ id: newId(), materialId: milk.id, qty: '10000', unit: 'l' }]
    const saved = ok(
      await shop.run<RecipeResultDto>('recipe.save', { productId: product.id, version: 0, lines }),
    )
    // With a yield of 1 its cost shows (10^7 ml × 10^15 = 10^22).
    expect(saved.data.cost.total).toBe('10000000000000000000000')
    ok(await shop.run('product.costs', { ids: [product.id] }))

    const tiny = await shop.run<RecipeResultDto>('recipe.save', {
      productId: product.id,
      version: saved.data.version,
      yieldQty: '0.000003',
      lines,
    })
    // Refused as a yield too small for this recipe, or answered: never INTERNAL (the save would
    // otherwise be stored while its answer fails, and every later read of the product with it).
    expect.soft(codeOf(tiny), 'recipe.save').not.toBe('internal')
    const got = await shop.run('recipe.get', { productId: product.id })
    expect.soft(codeOf(got), 'recipe.get').not.toBe('internal')
    const costs = await shop.run('product.costs', { ids: [product.id] })
    expect.soft(codeOf(costs), 'product.costs').not.toBe('internal')
  })
})
