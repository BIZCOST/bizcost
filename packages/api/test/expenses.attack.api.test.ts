import type {
  CostCategoryDto,
  ExpenseDto,
  PayableListDto,
  PurchaseDto,
  PurchasePaymentsDto,
} from '@bizcost/contracts'
import { withTenantTx } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { addMember, tenant } from './helpers'
import { codeOf, line, ok, purchaseInput, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Attacks on Expenses and Running Costs (M2 Step 5): getting round approval (posting what was not
// approved, changing what was, racing the reviewers), paying more than is owed or paying while the
// expense is reversed, reading hidden amounts through refusals, an expense that shares its id with a
// purchase, and writes the database refuses whatever path they take.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let category: CostCategoryDto
let clerk: Person
let manager: Person & { memberId: string }

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  category = await shop.category()
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

async function clerkDraft(extra: object = {}): Promise<ExpenseDto> {
  return ok(
    await shop.as<Envelope<ExpenseDto>>(
      clerk,
      'expense.create',
      shop.expenseInput(category.id, today, extra),
    ),
  ).data
}

async function submitted(extra: object = {}): Promise<ExpenseDto> {
  const draft = await clerkDraft(extra)
  return ok(
    await shop.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
      id: draft.id,
      version: draft.version,
    }),
  ).data
}

/** Runs `sql` as bizcost_api in the business, as the owner (the API's database role). */
async function asApiRole(statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTenantTx(api.db, tenant(shop.owner.user.id, shop.id), (tx) => tx.execute(statement))
    return 'ok'
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return cause?.code ?? (error as { code?: string }).code ?? 'error'
  }
}

describe('approval cannot be got round', () => {
  it('what was approved is what is posted: the database refuses a change after approval', async () => {
    const sent = await submitted()
    const approved = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
        id: sent.id,
        version: sent.version,
      }),
    ).data
    expect(
      await asApiRole(sql`update app.expenses set amount = 1, net_total = 1, vat_total = 0, total = 1
                           where id = ${approved.id}`),
    ).toBe('23001')
    expect(
      await asApiRole(sql`update app.expenses set status = 'submitted' where id = ${approved.id}`),
    ).toBe('23001')
    // Through the API: frozen too.
    expect(
      codeOf(
        await shop.as(clerk, 'expense.update', {
          ...shop.expenseInput(category.id, today, { amount: '1' }),
          id: approved.id,
          version: approved.version,
        }),
      ),
    ).toBe('expense_in_approval')
    const posted = ok(
      await shop.as<Envelope<ExpenseDto>>(clerk, 'expense.post', {
        id: approved.id,
        version: approved.version,
      }),
    ).data
    expect(posted).toMatchObject({ status: 'posted', total: '105' })
  })

  it('a draft is never posted without an approver, also with an old version or twice at once', async () => {
    const draft = await clerkDraft()
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        shop.as(clerk, 'expense.post', { id: draft.id, version: draft.version }),
      ),
    )
    expect(results.map(codeOf)).toEqual(Array(4).fill('approval_required'))
    const now = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: draft.id })).data
    expect(now.status).toBe('draft')
  })

  it('approve and reject racing: one review wins, never both', async () => {
    for (let round = 0; round < 3; round++) {
      const sent = await submitted()
      const [approve, reject] = await Promise.all([
        shop.as(manager, 'expense.approve', { id: sent.id, version: sent.version }),
        shop.run('expense.reject', { id: sent.id, version: sent.version, reason: 'No' }),
      ])
      const winners = [approve, reject].filter((r) => r.error === undefined)
      expect(winners).toHaveLength(1)
      const loser = [approve, reject].find((r) => r.error !== undefined)
      expect(['conflict', 'expense_not_submitted']).toContain(codeOf(loser!))
      const [row] = await api.admin<{ status: string; approved: boolean; rejected: boolean }[]>`
        select status, approved_at is not null as approved, rejected_at is not null as rejected
          from app.expenses where id = ${sent.id}`
      expect(row?.approved).toBe(row?.status === 'approved')
      expect(row?.rejected).toBe(row?.status === 'rejected')
    }
  })

  it('posting an approved expense races its rejection: posted and never rejected after', async () => {
    const sent = await submitted()
    const approved = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
        id: sent.id,
        version: sent.version,
      }),
    ).data
    const [post, reject] = await Promise.all([
      shop.as(clerk, 'expense.post', { id: approved.id, version: approved.version }),
      shop.as(manager, 'expense.reject', { id: approved.id, version: approved.version }),
    ])
    const after = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: approved.id })).data
    if (post.error === undefined) {
      expect(after.status).toBe('posted')
      expect(['document_posted', 'conflict']).toContain(codeOf(reject))
    } else {
      expect(after.status).toBe('rejected')
      expect(['approval_required', 'conflict']).toContain(codeOf(post))
    }
  })

  it('turning approval on while a draft is posted: posted before it, or refused after', async () => {
    ok(await shop.run('expense.updateSettings', { approval: false }))
    const drafts = await Promise.all(Array.from({ length: 3 }, () => clerkDraft()))
    const [, ...posts] = await Promise.all([
      shop.run('expense.updateSettings', { approval: true }),
      ...drafts.map((d) => shop.as(clerk, 'expense.post', { id: d.id, version: d.version })),
    ])
    for (const [index, result] of posts.entries()) {
      const after = ok(
        await shop.run<Envelope<ExpenseDto>>('expense.get', { id: drafts[index]!.id }),
      ).data
      if (result.error) {
        expect(codeOf(result)).toBe('approval_required')
        expect(after.status).toBe('draft')
      } else {
        expect(after).toMatchObject({ status: 'posted', approvedAt: null })
      }
    }
    expect(
      ok(await shop.run<{ approvalRequired: boolean }>('expense.settings')).approvalRequired,
    ).toBe(true)
  })

  it('a Manager cannot turn approval off to get round it; an override without the key cannot either', async () => {
    expect(codeOf(await shop.as(manager, 'expense.updateSettings', { approval: false }))).toBe(
      'forbidden',
    )
    expect(codeOf(await shop.as(clerk, 'expense.updateSettings', { approval: false }))).toBe(
      'forbidden',
    )
    expect(codeOf(await shop.as(clerk, 'expense.approve', { id: newId(), version: 1 }))).toBe(
      'forbidden',
    )
  })

  it('a rejected expense edited and sent again is approved only at its new version', async () => {
    const sent = await submitted()
    const rejected = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.reject', {
        id: sent.id,
        version: sent.version,
      }),
    ).data
    const bigger = ok(
      await shop.as<Envelope<ExpenseDto>>(clerk, 'expense.update', {
        ...shop.expenseInput(category.id, today, { amount: '5000' }),
        id: sent.id,
        version: rejected.version,
      }),
    ).data
    const again = ok(
      await shop.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: sent.id,
        version: bigger.version,
      }),
    ).data
    for (const version of [sent.version, rejected.version, bigger.version]) {
      expect(
        codeOf(await shop.as(manager, 'expense.approve', { id: sent.id, version })),
        String(version),
      ).toBe('conflict')
    }
    expect(again.total).toBe('5250')
  })
})

describe('what is owed cannot be overpaid or paid on a reversed expense', () => {
  async function owedExpense(): Promise<ExpenseDto> {
    const supplier = await shop.supplier()
    return shop.spend(
      shop.expenseInput(category.id, today, {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
  }
  const pay = (expenseId: string, amount: string) => ({
    id: newId(),
    expenseId,
    businessDate: today,
    method: 'cash',
    amount,
  })

  it('two payments of all that is owed at once: one is recorded, the other exceeds it', async () => {
    const bill = await owedExpense()
    const results = await Promise.all([
      shop.run('expensePayment.record', pay(bill.id, '105')),
      shop.run('expensePayment.record', pay(bill.id, '105')),
    ])
    expect(results.map(codeOf).sort()).toEqual(['exceeds_outstanding', undefined].sort())
    expect((await shop.expensePayments(bill.id)).paid).toBe('105')
  })

  it('a payment racing the expense’s reversal: the one that commits first wins', async () => {
    for (let round = 0; round < 3; round++) {
      const bill = await owedExpense()
      const [paid, reversed] = await Promise.all([
        shop.run('expensePayment.record', pay(bill.id, '10')),
        shop.run('expense.reverse', { id: bill.id }),
      ])
      const view = await shop.expensePayments(bill.id)
      if (paid.error === undefined) {
        expect(codeOf(reversed)).toBe('expense_has_payments')
        expect(view).toMatchObject({ status: 'posted', paid: '10' })
      } else {
        expect(codeOf(paid)).toBe('document_not_posted')
        expect(view).toMatchObject({ status: 'reversed', paid: '0' })
      }
    }
  })

  it('correcting an expense with payments is refused whole: no copy is left behind', async () => {
    const bill = await owedExpense()
    ok(await shop.run('expensePayment.record', pay(bill.id, '1')))
    const copyId = newId()
    expect(codeOf(await shop.run('expense.correct', { id: bill.id, newId: copyId }))).toBe(
      'expense_has_payments',
    )
    expect(codeOf(await shop.run('expense.get', { id: copyId }))).toBe('not_found')
  })

  it('a member who may not see supplier prices learns nothing from a refusal', async () => {
    const bill = await owedExpense()
    const blind = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, blind.user, {
      template: 'manager',
      overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
    })
    for (const amount of ['1', '104.99', '105', '105.01', '999999']) {
      expect(
        codeOf(await shop.as(blind, 'expensePayment.record', pay(bill.id, amount))),
        amount,
      ).toBe('forbidden')
    }
    expect(codeOf(await shop.as(blind, 'payable.list', { party: 'supplier' }))).toBe('forbidden')
    // They still see the expense, without its amounts.
    const seen = ok(await shop.as<Envelope<ExpenseDto>>(blind, 'expense.get', { id: bill.id }))
    expect(seen.data.total).toBeUndefined()
    expect(seen.meta.redacted).toEqual(
      expect.arrayContaining(['amount', 'netTotal', 'vatTotal', 'total', 'costTotal']),
    )
  })
})

describe('an expense that shares its id with a purchase stays apart', () => {
  it('its amounts, payments, receipts and what is owed are its own', async () => {
    const supplier = await shop.supplier()
    const milk = await shop.material()
    const purchase: PurchaseDto = await shop.buy(
      purchaseInput(today, [line(milk.id, '1', '30')], {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    // The client picks ids: the same id is accepted in another table.
    const twin = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.create',
        shop.expenseInput(category.id, today, {
          id: purchase.id,
          supplierId: supplier.id,
          paymentMethod: 'supplier_credit',
        }),
      ),
    ).data
    const posted = await shop.postExpense(twin)
    expect(posted.id).toBe(purchase.id)
    ok(
      await shop.run('expensePayment.record', {
        id: newId(),
        expenseId: purchase.id,
        businessDate: today,
        method: 'cash',
        amount: '100',
      }),
    )
    const expenseView = await shop.expensePayments(purchase.id)
    expect(expenseView).toMatchObject({ total: '105', paid: '100', outstanding: '5' })
    const purchaseView = ok(
      await shop.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.list', {
        purchaseId: purchase.id,
      }),
    ).data
    expect(purchaseView).toMatchObject({ total: '30', paid: '0', outstanding: '30' })
    const owed = ok(
      await shop.run<Envelope<PayableListDto['data']>>('payable.list', { party: 'supplier' }),
    ).data
    const invoices = owed.groups.find((g) => g.partyId === supplier.id)!.invoices
    expect(invoices.map((i) => [i.kind, i.documentId, i.outstanding]).sort()).toEqual(
      [
        ['expense', purchase.id, '5'],
        ['purchase', purchase.id, '30'],
      ].sort(),
    )
    // The purchase is not reversed through the expense's payments, nor the other way round.
    expect(codeOf(await shop.run('expense.reverse', { id: purchase.id }))).toBe(
      'expense_has_payments',
    )
    ok(await shop.run('purchase.reverse', { id: purchase.id }))
    const still = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: purchase.id })).data
    expect(still.status).toBe('posted')
  })
})

describe('writes the rules refuse, whatever path they take', () => {
  it('categories, suppliers, members and locations of another business are not found', async () => {
    const other = await ExpenseScope.open(api, WORKSHOP)
    const theirCategory = await other.category()
    const theirSupplier = await other.supplier()
    const [theirMember] = await api.admin<{ id: string }[]>`
      select id from app.business_members where business_id = ${other.id} limit 1`
    for (const extra of [
      { categoryId: theirCategory.id },
      { supplierId: theirSupplier.id },
      { paymentMethod: 'paid_by_member', paidByMemberId: theirMember!.id },
    ]) {
      expect(
        codeOf(await shop.run('expense.create', shop.expenseInput(category.id, today, extra))),
        JSON.stringify(extra),
      ).toBe('not_found')
    }
    // Through the database too: composite foreign keys.
    expect(
      await asApiRole(sql`
        insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                  document_type, payment_method, currency, amount, net_total,
                                  vat_total, total)
        select ${newId()}, ${shop.id}, ${theirCategory.id}, l.id, current_date, 'no_invoice',
               'cash', 'AED', 1, 1, 0, 1
          from app.locations l where l.business_id = ${shop.id} and l.is_default`),
    ).toBe('23503')
  })

  it('a receipt goes only to a live expense, under its own kind of path', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(category.id, today))
    ok(await shop.run('expense.discard', { id: draft.id, version: draft.version }))
    expect(
      codeOf(
        await shop.run('attachment.uploadUrl', {
          entity: 'expense',
          entityId: draft.id,
          contentType: 'image/png',
        }),
      ),
    ).toBe('not_found')
    const live = await shop.expenseDraft(shop.expenseInput(category.id, today))
    expect(
      codeOf(
        await shop.run('attachment.add', {
          entity: 'expense',
          entityId: live.id,
          path: `${shop.id}/purchase/${newId()}.png`,
          fileName: 'x.png',
        }),
      ),
    ).toBe('validation')
  })

  it('an idempotent create replayed with another payload is CONFLICT; a discarded id stays taken', async () => {
    const input = shop.expenseInput(category.id, today)
    const first = ok(await shop.run<Envelope<ExpenseDto>>('expense.create', input)).data
    const again = ok(await shop.run<Envelope<ExpenseDto>>('expense.create', input)).data
    expect(again.id).toBe(first.id)
    expect(codeOf(await shop.run('expense.create', { ...input, amount: '1' }))).toBe('conflict')
    ok(await shop.run('expense.discard', { id: first.id, version: first.version }))
    expect(codeOf(await shop.run('expense.create', input))).toBe('conflict')
    // Someone else replaying my id: CONFLICT.
    expect(
      codeOf(
        await shop.as(
          manager,
          'expense.create',
          shop.expenseInput(category.id, today, { id: first.id }),
        ),
      ),
    ).toBe('conflict')
  })

  it('a posted expense is only reversed; a reversed one never comes back', async () => {
    const posted = await shop.spend(shop.expenseInput(category.id, today))
    expect(
      await asApiRole(sql`update app.expenses set status = 'draft', posted_at = null, posted_by = null,
                                  vat_in_cost = null, cost_total = null where id = ${posted.id}`),
    ).toBe('23001')
    ok(await shop.run('expense.reverse', { id: posted.id }))
    expect(
      await asApiRole(sql`update app.expenses set status = 'posted', reversed_at = null,
                                  reversed_by = null, reversal_date = null where id = ${posted.id}`),
    ).toBe('23001')
    expect(await asApiRole(sql`delete from app.expenses where id = ${posted.id}`)).toBe('23001')
    // A payment row is never forged on it either.
    expect(
      await asApiRole(sql`
        insert into app.expense_payments (id, business_id, expense_id, business_date, method, amount,
                                          currency)
        values (${newId()}, ${shop.id}, ${posted.id}, current_date, 'cash', 1, 'AED')`),
    ).toBe('23514')
  })

  it('the books closed through today: posting and reversing wait for the owner', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const day = await scope.today()
    const cat = await scope.category()
    const posted = await scope.spend(scope.expenseInput(cat.id, day))
    const draft = await scope.expenseDraft(scope.expenseInput(cat.id, day))
    ok(await scope.run('books.close', { closedThrough: day }))
    expect(codeOf(await scope.run('expense.post', { id: draft.id, version: draft.version }))).toBe(
      'books_closed',
    )
    expect(codeOf(await scope.run('expense.reverse', { id: posted.id }))).toBe('books_closed')
    ok(await scope.run('books.close', { closedThrough: null }))
    ok(await scope.run('expense.reverse', { id: posted.id }))
  })
})

describe('what running costs reveal', () => {
  it('without cost visibility: names, categories, dates and states, never an amount', async () => {
    const cost = await shop.runningCost({
      id: newId(),
      name: 'Warehouse rent',
      categoryId: category.id,
      amount: '4321.98',
      startsOn: today,
    })
    const blind = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, blind.user, {
      template: 'employee',
      overrides: [{ key: 'running_costs.items.view', effect: 'allow' }],
    })
    const one = await shop.as<Envelope<{ amount?: string }>>(blind, 'runningCost.get', {
      id: cost.id,
    })
    expect(one.raw.includes('4321.98')).toBe(false)
    expect(ok(one).meta.redacted).toEqual(['amount', 'monthlyAmount'])
    const list = await shop.as(blind, 'runningCost.list', { search: 'warehouse' })
    expect(list.raw.includes('4321.98')).toBe(false)
    // Writing needs "manage"; a view-only member cannot probe amounts through refusals.
    expect(
      codeOf(
        await shop.as(blind, 'runningCost.update', {
          id: cost.id,
          version: cost.version,
          name: 'x',
          categoryId: category.id,
          amount: '1',
          startsOn: today,
        }),
      ),
    ).toBe('forbidden')
  })

  it('an Employee may not see or manage categories without expenses or running costs', async () => {
    const employee = await api.member(shop, 'employee')
    expect(codeOf(await shop.as(employee, 'costCategory.list'))).toBe('forbidden')
    expect(codeOf(await shop.as(employee, 'costCategory.create', { id: newId(), name: 'x' }))).toBe(
      'forbidden',
    )
    expect(codeOf(await shop.as(employee, 'costCategory.archive', { id: category.id }))).toBe(
      'forbidden',
    )
    const listed = ok(
      await shop.run<{ items: CostCategoryDto[] }>('costCategory.list', { limit: 100 }),
    )
    expect(listed.items.some((c) => c.id === category.id)).toBe(true)
  })
})
