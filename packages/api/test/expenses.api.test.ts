import { readdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  CostCategoryDto,
  ExpenseDto,
  ExpenseListDto,
  ExpenseSettingsDto,
  PayableListDto,
  PurchaseDto,
  RunningCostDto,
  RunningCostListDto,
} from '@bizcost/contracts'
import { newId, STARTER_COST_CATEGORIES } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXPENSES_PREVIEW, ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { PNG, uploadTo } from './hardening/fixture'
import { addMember, handlerFor } from './helpers'
import { codeOf, line, ok, purchaseInput, type Person } from './purchasing'
import { BAKER, setupBusiness, WORKSHOP } from './settings'

// Expenses and Running Costs (ROADMAP.md M2 Step 5; D-114, D-116, D-164–D-170), through the real
// fetch handler with the modules previewed: the starter categories and the shared list; an expense's
// amounts before or with VAT and what it costs by the VAT rule; how it was paid; drafts, posting,
// reversing and correcting, with the books-closed date; receipts; optional approval with a team;
// what an expense leaves owed in "Amounts owed" next to purchases, and paying it; running costs and
// their monthly amounts; who may see and do what.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let yesterday: string
let rent: CostCategoryDto

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  yesterday = day.toISOString().slice(0, 10)
  rent = (await shop.categories()).find((c) => c.name === 'Rent')!
}, 60_000)

afterAll(async () => {
  await api.close()
})

function shift(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------------------------------

describe('the categories expenses and running costs share (D-116)', () => {
  it('a new business starts with the owner’s list, in its language', async () => {
    const english = (await shop.categories()).map((c) => c.name).sort()
    const en = createI18n({ locale: 'en', namespaces: ['setup'] })
    expect(english).toEqual(
      STARTER_COST_CATEGORIES.map((key) => en.t(`setup.cost_categories.${key}` as I18nKey)).sort(),
    )
    expect(english).toContain('Software subscriptions')

    const owner = await api.person()
    const id = await setupBusiness(api.handler, owner.token, BAKER, { locale: 'ar', name: 'مخبز' })
    const arabic = ok(
      await api.call<{ items: CostCategoryDto[] }>(owner, id, 'costCategory.list', { limit: 100 }),
    ).items.map((c) => c.name)
    expect(arabic).toHaveLength(STARTER_COST_CATEGORIES.length)
    expect(arabic).toEqual(expect.arrayContaining(['الإيجار', 'الكهرباء', 'الرواتب', 'أخرى']))
  })

  it('the migration gave businesses made before the same names as Smart Setup (a guard)', () => {
    const dir = joinPath(__dirname, '..', '..', '..', 'supabase', 'migrations')
    const file = readdirSync(dir).find((name) => name.endsWith('_expenses_security.sql'))!
    const sql = readFileSync(joinPath(dir, file), 'utf8')
    const en = createI18n({ locale: 'en', namespaces: ['setup'] })
    const ar = createI18n({ locale: 'ar', namespaces: ['setup'] })
    for (const key of STARTER_COST_CATEGORIES) {
      const row = `('${key}', '${en.t(`setup.cost_categories.${key}` as I18nKey).replaceAll("'", "''")}', '${ar.t(`setup.cost_categories.${key}` as I18nKey)}')`
      expect(sql, key).toContain(row)
    }
  })

  it('one name per business the way people read it; renamed, archived and brought back', async () => {
    const taken = await shop.run('costCategory.create', { id: newId(), name: '  RENT ' })
    expect(codeOf(taken)).toBe('name_taken')
    expect(taken.error?.data.names).toEqual(['Rent'])
    const owner = await api.person()
    const id = await setupBusiness(api.handler, owner.token, BAKER, { locale: 'ar', name: 'مقهى' })
    const hamza = await api.call(owner, id, 'costCategory.create', { id: newId(), name: 'الايجار' })
    expect(codeOf(hamza)).toBe('name_taken')

    const packaging = await shop.category(`Packaging ${newId().slice(-6)}`)
    const renamed = ok(
      await shop.run<CostCategoryDto>('costCategory.update', {
        id: packaging.id,
        version: packaging.version,
        name: `${packaging.name} and bags`,
      }),
    )
    expect(renamed.name).toBe(`${packaging.name} and bags`)
    expect(
      codeOf(
        await shop.run('costCategory.update', {
          id: packaging.id,
          version: packaging.version,
          name: 'x',
        }),
      ),
    ).toBe('conflict')
    const archived = ok(
      await shop.run<CostCategoryDto>('costCategory.archive', { id: packaging.id }),
    )
    expect(archived.archivedAt).not.toBeNull()
    const active = ok(
      await shop.run<{ items: CostCategoryDto[] }>('costCategory.list', {
        limit: 100,
      }),
    ).items
    expect(active.some((c) => c.id === packaging.id)).toBe(false)
    const back = ok(await shop.run<CostCategoryDto>('costCategory.unarchive', { id: packaging.id }))
    expect(back.archivedAt).toBeNull()
  })

  it('a new expense or running cost needs an active category; one it has may stay archived', async () => {
    const old = await shop.category()
    const expense = await shop.expenseDraft(shop.expenseInput(old.id, today))
    ok(await shop.run('costCategory.archive', { id: old.id }))
    expect(codeOf(await shop.run('expense.create', shop.expenseInput(old.id, today)))).toBe(
      'validation',
    )
    // Saved again with the category it has: fine.
    const again = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...shop.expenseInput(old.id, today),
        id: expense.id,
        version: expense.version,
        description: 'Kept',
      }),
    ).data
    expect(again).toMatchObject({ categoryId: old.id, description: 'Kept' })
    expect(
      codeOf(
        await shop.run('runningCost.create', {
          id: newId(),
          name: 'Old',
          categoryId: old.id,
          amount: '10',
          startsOn: today,
        }),
      ),
    ).toBe('validation')
    // Another business's category is not found.
    const other = await ExpenseScope.open(api, BAKER)
    const theirs = (await other.categories())[0]!
    expect(codeOf(await shop.run('expense.create', shop.expenseInput(theirs.id, today)))).toBe(
      'not_found',
    )
  })
})

// ---------------------------------------------------------------------------------------------------

describe('an expense’s amounts and what it costs (D-114 rule 4, D-157)', () => {
  it('before VAT: 100 at 5 % is 100 + 5 = 105', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    expect(draft).toMatchObject({
      status: 'draft',
      amount: '100',
      vatRate: '5',
      netTotal: '100',
      vatTotal: '5',
      total: '105',
      vatInCost: null,
      costTotal: null,
      categoryName: 'Rent',
      approvalRequired: false,
    })
  })

  it('including VAT: 105 is 100 + 5; 10 is 9.52 + 0.48', async () => {
    const draft = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, { amount: '105', pricesIncludeVat: true }),
    )
    expect(draft).toMatchObject({ netTotal: '100', vatTotal: '5', total: '105' })
    const small = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, { amount: '10', pricesIncludeVat: true }),
    )
    expect(small).toMatchObject({ netTotal: '9.52', vatTotal: '0.48', total: '10' })
  })

  it('at posting, VAT is part of the cost only when it cannot be reclaimed', async () => {
    // WORKSHOP is VAT-registered.
    const cases = [
      [{ documentType: 'tax_invoice' }, '100'],
      [{ documentType: 'tax_invoice', vatNotReclaimable: true }, '105'],
      [{ documentType: 'non_tax_invoice' }, '105'],
      [{ documentType: 'no_invoice' }, '105'],
    ] as const
    for (const [extra, cost] of cases) {
      const posted = await shop.spend(shop.expenseInput(rent.id, today, extra))
      expect(posted, JSON.stringify(extra)).toMatchObject({
        status: 'posted',
        total: '105',
        costTotal: cost,
        vatInCost: cost === '105',
      })
    }
    // A business that isn't VAT-registered: what was paid is the cost.
    const baker = await ExpenseScope.open(api, BAKER)
    const flour = (await baker.categories())[0]!
    const posted = await baker.spend(baker.expenseInput(flour.id, await baker.today()))
    expect(posted).toMatchObject({ total: '105', costTotal: '105', vatInCost: true })
  })

  it('an amount the currency cannot hold as typed, zero or negative is refused', async () => {
    for (const amount of ['10.005', '0', '-1']) {
      expect(
        codeOf(await shop.run('expense.create', shop.expenseInput(rent.id, today, { amount }))),
        amount,
      ).toBe('validation')
    }
    // Arabic digits are read.
    const arabic = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, { amount: '١٢٫٥٠', vatRate: '0' }),
    )
    expect(arabic).toMatchObject({ amount: '12.5', total: '12.5' })
  })
})

// ---------------------------------------------------------------------------------------------------

describe('how an expense was paid (D-159)', () => {
  it('is required; on credit needs a supplier; paid personally needs an active member', async () => {
    const input = shop.expenseInput(rent.id, today)
    expect(codeOf(await shop.run('expense.create', { ...input, paymentMethod: undefined }))).toBe(
      'validation',
    )
    expect(
      codeOf(await shop.run('expense.create', { ...input, paymentMethod: 'supplier_credit' })),
    ).toBe('validation')
    expect(
      codeOf(
        await shop.run('expense.create', {
          ...input,
          paymentMethod: 'paid_by_member',
          paidByMemberId: newId(),
        }),
      ),
    ).toBe('not_found')
    const supplier = await shop.supplier()
    const onCredit = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    expect(onCredit).toMatchObject({
      supplierName: supplier.name,
      paymentMethod: 'supplier_credit',
    })
  })

  it('a member who paid and has left stops the posting (NOT_FOUND)', async () => {
    const leaver = await api.member(shop, 'manager')
    const draft = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, {
        paymentMethod: 'paid_by_member',
        paidByMemberId: leaver.memberId,
      }),
    )
    expect(draft.paidByMemberName).toBeTruthy()
    ok(await shop.as(leaver, 'member.leave'))
    expect(codeOf(await shop.run('expense.post', { id: draft.id, version: draft.version }))).toBe(
      'not_found',
    )
  })
})

// ---------------------------------------------------------------------------------------------------

describe('drafts, posting, reversing and correcting', () => {
  it('a draft changes; posting is final and idempotent; a posted expense is only reversed', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    const changed = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...shop.expenseInput(rent.id, today, { amount: '200', description: 'Two months' }),
        id: draft.id,
        version: draft.version,
      }),
    ).data
    expect(changed).toMatchObject({ total: '210', description: 'Two months', status: 'draft' })
    expect(codeOf(await shop.run('expense.post', { id: draft.id, version: draft.version }))).toBe(
      'conflict',
    )
    const posted = await shop.postExpense(changed)
    expect(posted).toMatchObject({ status: 'posted', costTotal: '200' })
    expect(await shop.postExpense(changed)).toMatchObject({ status: 'posted', id: draft.id })
    expect(
      codeOf(
        await shop.run('expense.update', {
          ...shop.expenseInput(rent.id, today),
          id: draft.id,
          version: posted.version,
        }),
      ),
    ).toBe('document_posted')
    expect(
      codeOf(await shop.run('expense.discard', { id: draft.id, version: posted.version })),
    ).toBe('document_posted')
    const reversed = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.reverse', { id: draft.id }),
    ).data
    expect(reversed).toMatchObject({ status: 'reversed', reversalDate: today })
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.reverse', { id: draft.id })).data,
    ).toEqual(reversed)
    expect(
      codeOf(
        await shop.run('expense.reverse', {
          id: (await shop.expenseDraft(shop.expenseInput(rent.id, today))).id,
        }),
      ),
    ).toBe('document_not_posted')
  })

  it('a day after today is not posted; the books-closed date is kept, and a reversal moves', async () => {
    const future = await shop.expenseDraft(shop.expenseInput(rent.id, shift(today, 1)))
    expect(codeOf(await shop.run('expense.post', { id: future.id, version: future.version }))).toBe(
      'future_date',
    )
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const category = (await scope.categories())[0]!
    const posted = await scope.spend(scope.expenseInput(category.id, yesterday))
    const later = await scope.expenseDraft(scope.expenseInput(category.id, yesterday))
    ok(await scope.run('books.close', { closedThrough: yesterday }))
    expect(codeOf(await scope.run('expense.post', { id: later.id, version: later.version }))).toBe(
      'books_closed',
    )
    const reversed = ok(
      await scope.run<Envelope<ExpenseDto>>('expense.reverse', { id: posted.id }),
    ).data
    expect(reversed.reversalDate).toBe(today)
  })

  it('correct: reversed, and a copy opened as a new draft (idempotent on the new id)', async () => {
    const posted = await shop.spend(
      shop.expenseInput(rent.id, today, { description: 'Wrong amount', reference: 'INV-7' }),
    )
    const newIdValue = newId()
    const copy = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.correct', { id: posted.id, newId: newIdValue }),
    ).data
    expect(copy).toMatchObject({
      id: newIdValue,
      status: 'draft',
      copiedFromId: posted.id,
      description: 'Wrong amount',
      reference: 'INV-7',
      total: '105',
    })
    const again = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.correct', { id: posted.id, newId: newIdValue }),
    ).data
    expect(again.id).toBe(newIdValue)
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: posted.id })).data.status,
    ).toBe('reversed')
    // A draft is edited, not corrected; a new id used elsewhere is CONFLICT.
    expect(codeOf(await shop.run('expense.correct', { id: copy.id, newId: newId() }))).toBe(
      'document_not_posted',
    )
    const other = await shop.spend(shop.expenseInput(rent.id, today))
    expect(codeOf(await shop.run('expense.correct', { id: other.id, newId: copy.id }))).toBe(
      'conflict',
    )
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: other.id })).data.status,
    ).toBe('posted')
  })

  it('lists newest first, with filters in the address', async () => {
    const category = await shop.category()
    const supplier = await shop.supplier()
    const a = await shop.spend(
      shop.expenseInput(category.id, yesterday, {
        description: 'Printer ink',
        supplierId: supplier.id,
      }),
    )
    const b = await shop.expenseDraft(shop.expenseInput(category.id, today, { reference: 'R-99' }))
    const list = async (input: object) =>
      ok(await shop.run<Envelope<ExpenseListDto['data']>>('expense.list', input)).data.items.map(
        (i) => i.id,
      )
    expect(await list({ categoryId: category.id })).toEqual([b.id, a.id])
    expect(await list({ categoryId: category.id, status: 'posted' })).toEqual([a.id])
    expect(await list({ categoryId: category.id, search: 'printer' })).toEqual([a.id])
    expect(await list({ categoryId: category.id, search: supplier.name })).toEqual([a.id])
    expect(await list({ search: 'R-99' })).toEqual([b.id])
    expect(await list({ categoryId: category.id, from: today })).toEqual([b.id])
    const first = ok(
      await shop.run<Envelope<ExpenseListDto['data']>>('expense.list', {
        categoryId: category.id,
        limit: 1,
      }),
    ).data
    expect(first.items.map((i) => i.id)).toEqual([b.id])
    const second = ok(
      await shop.run<Envelope<ExpenseListDto['data']>>('expense.list', {
        categoryId: category.id,
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).data
    expect(second.items.map((i) => i.id)).toEqual([a.id])
    expect(second.items[0]).toMatchObject({ categoryName: category.name, total: '105' })
    expect(codeOf(await shop.run('expense.list', { categoryId: newId() }))).toBe('not_found')
  })
})

// ---------------------------------------------------------------------------------------------------

describe('receipts on an expense', () => {
  it('are added, listed with a signed URL, and go with a discarded draft', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    const upload = ok(
      await shop.run<AttachmentUploadUrlDto>('attachment.uploadUrl', {
        entity: 'expense',
        entityId: draft.id,
        contentType: 'image/png',
      }),
    )
    expect(upload.path.startsWith(`${shop.id}/expense/`)).toBe(true)
    expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    const added = ok(
      await shop.run<Envelope<AttachmentDto>>('attachment.add', {
        entity: 'expense',
        entityId: draft.id,
        path: upload.path,
        fileName: 'bill.png',
      }),
    ).data
    expect(added.url).toContain('/object/sign/')
    const listed = ok(
      await shop.run<Envelope<{ items: AttachmentDto[] }>>('attachment.list', {
        entity: 'expense',
        entityId: draft.id,
      }),
    ).data.items
    expect(listed.map((a) => a.id)).toEqual([added.id])
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: draft.id })).data
        .attachmentCount,
    ).toBe(1)
    // A purchase's id is not an expense (and the other way round).
    expect(
      codeOf(await shop.run('attachment.list', { entity: 'purchase', entityId: draft.id })),
    ).toBe('not_found')
    ok(await shop.run('expense.discard', { id: draft.id, version: draft.version }))
    const [row] = await api.admin<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.attachments where id = ${added.id}`
    expect(row?.deleted).toBe(true)
    expect(codeOf(await shop.run('expense.get', { id: draft.id }))).toBe('not_found')
  })

  it('follow the expense’s keys: a member who enters purchases only cannot add one', async () => {
    const draft = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    const buyer = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, buyer.user, {
      template: 'manager',
      overrides: [
        { key: 'expenses.documents.view', effect: 'deny' },
        { key: 'expenses.documents.manage', effect: 'deny' },
      ],
    })
    const input = { entity: 'expense', entityId: draft.id, contentType: 'image/png' }
    expect(codeOf(await shop.as(buyer, 'attachment.uploadUrl', input))).toBe('forbidden')
    expect(
      codeOf(await shop.as(buyer, 'attachment.list', { entity: 'expense', entityId: draft.id })),
    ).toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------------------------------

describe('approval before an expense is final (D-164)', () => {
  let team: ExpenseScope
  let category: CostCategoryDto
  let day: string
  let clerk: Person
  let manager: Person & { memberId: string }

  beforeAll(async () => {
    team = await ExpenseScope.open(api, WORKSHOP)
    day = await team.today()
    category = (await team.categories())[0]!
    // A member who enters and finalizes expenses but may not approve them.
    clerk = await api.person()
    await addMember(api.db, team.owner.user, team.id, clerk.user, {
      template: 'employee',
      overrides: [
        { key: 'expenses.documents.view', effect: 'allow' },
        { key: 'expenses.documents.manage', effect: 'allow' },
        { key: 'expenses.documents.post', effect: 'allow' },
        { key: 'data.cost.view', effect: 'allow' },
        { key: 'data.supplier_price.view', effect: 'allow' },
        // Costs, supplier prices and margins are visible only together (D-187).
        { key: 'data.profit_margin.view', effect: 'allow' },
      ],
    })
    manager = await api.member(team, 'manager')
  }, 60_000)

  const settings = async (as?: Person) =>
    ok(
      await (as
        ? team.as<ExpenseSettingsDto>(as, 'expense.settings')
        : team.run<ExpenseSettingsDto>('expense.settings')),
    )

  it('is off by default; only the Owner or an Admin turns it on, with a team', async () => {
    expect(await settings()).toEqual({ approval: false, approvalRequired: false, hasTeam: true })
    const draft = await team.expenseDraft(team.expenseInput(category.id, day))
    expect(
      codeOf(await team.as(clerk, 'expense.submit', { id: draft.id, version: draft.version })),
    ).toBe('approval_off')
    expect(codeOf(await team.as(manager, 'expense.updateSettings', { approval: true }))).toBe(
      'forbidden',
    )
    expect(
      ok(await team.run<ExpenseSettingsDto>('expense.updateSettings', { approval: true })),
    ).toEqual({
      approval: true,
      approvalRequired: true,
      hasTeam: true,
    })
    // A business without a team has no approval.
    const baker = await ExpenseScope.open(api, BAKER)
    expect(ok(await baker.run<ExpenseSettingsDto>('expense.settings'))).toEqual({
      approval: false,
      approvalRequired: false,
      hasTeam: false,
    })
    expect(codeOf(await baker.run('expense.updateSettings', { approval: true }))).toBe(
      'capability_disabled',
    )
  })

  it('sent, frozen while reviewed, approved, then finalized', async () => {
    const draft = ok(
      await team.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        team.expenseInput(category.id, day),
      ),
    ).data
    expect(draft.approvalRequired).toBe(true)
    expect(
      codeOf(await team.as(clerk, 'expense.post', { id: draft.id, version: draft.version })),
    ).toBe('approval_required')
    const sent = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: draft.id,
        version: draft.version,
      }),
    ).data
    expect(sent).toMatchObject({ status: 'submitted', submittedBy: { name: expect.any(String) } })
    expect(
      codeOf(
        await team.as(clerk, 'expense.update', {
          ...team.expenseInput(category.id, day, { amount: '1' }),
          id: draft.id,
          version: sent.version,
        }),
      ),
    ).toBe('expense_in_approval')
    expect(
      codeOf(await team.as(clerk, 'expense.discard', { id: draft.id, version: sent.version })),
    ).toBe('expense_in_approval')
    expect(
      codeOf(await team.as(clerk, 'expense.post', { id: draft.id, version: sent.version })),
    ).toBe('approval_required')
    expect(
      codeOf(await team.as(clerk, 'expense.approve', { id: draft.id, version: sent.version })),
    ).toBe('forbidden')
    const approved = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
        id: draft.id,
        version: sent.version,
      }),
    ).data
    expect(approved).toMatchObject({
      status: 'approved',
      approvedBy: { memberId: manager.memberId },
    })
    const posted = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.post', {
        id: draft.id,
        version: approved.version,
      }),
    ).data
    expect(posted).toMatchObject({
      status: 'posted',
      approvedBy: { memberId: manager.memberId },
      costTotal: '100',
    })
  })

  it('rejected with a reason, changed and sent again; an old version is not approved', async () => {
    const draft = ok(
      await team.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        team.expenseInput(category.id, day),
      ),
    ).data
    const sent = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: draft.id,
        version: draft.version,
      }),
    ).data
    const rejected = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.reject', {
        id: draft.id,
        version: sent.version,
        reason: '  No receipt  ',
      }),
    ).data
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectionReason: 'No receipt',
      rejectedBy: { memberId: manager.memberId },
    })
    expect(
      codeOf(
        await team.as(manager, 'expense.approve', { id: draft.id, version: rejected.version }),
      ),
    ).toBe('expense_not_submitted')
    const edited = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.update', {
        ...team.expenseInput(category.id, day, { amount: '80' }),
        id: draft.id,
        version: rejected.version,
      }),
    ).data
    expect(edited).toMatchObject({ status: 'draft', total: '84', rejectionReason: 'No receipt' })
    const again = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: draft.id,
        version: edited.version,
      }),
    ).data
    expect(again).toMatchObject({ status: 'submitted', rejectedAt: null, rejectionReason: null })
    // What the approver read first is not what is there now.
    expect(
      codeOf(await team.as(manager, 'expense.approve', { id: draft.id, version: sent.version })),
    ).toBe('conflict')
    ok(await team.as(manager, 'expense.approve', { id: draft.id, version: again.version }))
  })

  it('an approver finalizes directly (their approval recorded); turned off, a sent one is finalized', async () => {
    const draft = await team.expenseDraft(team.expenseInput(category.id, day))
    const posted = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.post', {
        id: draft.id,
        version: draft.version,
      }),
    ).data
    expect(posted).toMatchObject({ status: 'posted', approvedBy: { memberId: manager.memberId } })

    const waiting = ok(
      await team.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        team.expenseInput(category.id, day),
      ),
    ).data
    const sent = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: waiting.id,
        version: waiting.version,
      }),
    ).data
    ok(await team.run('expense.updateSettings', { approval: false }))
    const done = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.post', {
        id: waiting.id,
        version: sent.version,
      }),
    ).data
    expect(done).toMatchObject({ status: 'posted', approvedAt: null, approvalRequired: false })
    ok(await team.run('expense.updateSettings', { approval: true }))
  })

  it('an approver who finalizes a rejected expense after all: approved by them, no longer rejected', async () => {
    const draft = ok(
      await team.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        team.expenseInput(category.id, day),
      ),
    ).data
    const sent = ok(
      await team.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
        id: draft.id,
        version: draft.version,
      }),
    ).data
    const rejected = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.reject', {
        id: draft.id,
        version: sent.version,
        reason: 'Check the date',
      }),
    ).data
    // The one who entered it may not finalize it now; an approver may.
    expect(
      codeOf(await team.as(clerk, 'expense.post', { id: draft.id, version: rejected.version })),
    ).toBe('approval_required')
    const posted = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.post', {
        id: draft.id,
        version: rejected.version,
      }),
    ).data
    expect(posted).toMatchObject({
      status: 'posted',
      approvedBy: { memberId: manager.memberId },
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    })
  })

  it('an approver sees what is waiting: the list filtered by status', async () => {
    const draft = ok(
      await team.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        team.expenseInput(category.id, day),
      ),
    ).data
    ok(await team.as(clerk, 'expense.submit', { id: draft.id, version: draft.version }))
    const waiting = ok(
      await team.as<Envelope<ExpenseListDto['data']>>(manager, 'expense.list', {
        status: 'submitted',
      }),
    ).data.items
    expect(waiting.map((i) => i.id)).toContain(draft.id)
    expect(waiting.every((i) => i.status === 'submitted')).toBe(true)
    expect(waiting.find((i) => i.id === draft.id)?.createdBy.name).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------------

describe('what an expense leaves owed, next to purchases (D-166)', () => {
  it('on credit: listed under its supplier with the purchases; paid in parts; reversal waits', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const day = await scope.today()
    const category = (await scope.categories()).find((c) => c.name === 'Electricity')!
    const supplier = await scope.supplier('DEWA')
    const milk = await scope.material()
    const purchase: PurchaseDto = await scope.buy(
      purchaseInput(day, [line(milk.id, '1', '10')], {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    const bill = await scope.spend(
      scope.expenseInput(category.id, day, {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
        description: 'September bill',
      }),
    )
    const owed = ok(
      await scope.run<Envelope<PayableListDto['data']>>('payable.list', { party: 'supplier' }),
    ).data
    expect(owed.total).toBe('115')
    const group = owed.groups.find((g) => g.partyId === supplier.id)!
    expect(group).toMatchObject({ outstanding: '115', invoiceCount: 2 })
    expect(group.invoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'purchase', documentId: purchase.id, categoryName: null }),
        expect.objectContaining({
          kind: 'expense',
          documentId: bill.id,
          categoryName: 'Electricity',
          itemNames: ['September bill'],
          total: '105',
          returned: '0',
          outstanding: '105',
        }),
      ]),
    )

    const pay = (amount: string) => ({
      id: newId(),
      expenseId: bill.id,
      businessDate: day,
      method: 'bank_transfer',
      amount,
    })
    expect(codeOf(await scope.run('expensePayment.record', pay('105.01')))).toBe(
      'exceeds_outstanding',
    )
    expect(codeOf(await scope.run('expensePayment.record', pay('1.005')))).toBe('validation')
    const first = pay('40')
    const after = ok(
      await scope.run<Envelope<{ outstanding: string; paid: string }>>(
        'expensePayment.record',
        first,
      ),
    ).data
    expect(after).toMatchObject({ paid: '40', outstanding: '65' })
    // The same payment again is answered, not counted twice.
    expect(
      ok(await scope.run<Envelope<{ paid: string }>>('expensePayment.record', first)).data.paid,
    ).toBe('40')
    expect(codeOf(await scope.run('expense.reverse', { id: bill.id }))).toBe('expense_has_payments')
    const view = await scope.expensePayments(bill.id)
    expect(view).toMatchObject({
      expenseId: bill.id,
      status: 'posted',
      owedTo: { party: 'supplier', partyId: supplier.id, name: 'DEWA' },
      total: '105',
      returned: '0',
      paid: '40',
      outstanding: '65',
      overpaid: '0',
    })
    ok(await scope.run('expensePayment.record', pay('65')))
    const settled = ok(
      await scope.run<Envelope<PayableListDto['data']>>('payable.list', { party: 'supplier' }),
    ).data
    expect(settled.total).toBe('10')
    expect(settled.groups[0]?.invoices.map((i) => i.kind)).toEqual(['purchase'])
    for (const payment of (await scope.expensePayments(bill.id)).payments) {
      ok(await scope.run('expensePayment.reverse', { id: payment.id }))
    }
    expect((await scope.expensePayments(bill.id)).outstanding).toBe('105')
    ok(await scope.run('expense.reverse', { id: bill.id }))
    expect((await scope.expensePayments(bill.id)).outstanding).toBe('0')
  })

  it('paid personally: owed to the member; nothing is owed on a draft or a cash expense', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const day = await scope.today()
    const category = (await scope.categories())[0]!
    const admin = await api.member(scope, 'admin')
    const taxi = await scope.spend(
      scope.expenseInput(category.id, day, {
        paymentMethod: 'paid_by_member',
        paidByMemberId: admin.memberId,
        amount: '42',
        vatRate: '0',
        documentType: 'no_invoice',
      }),
    )
    const members = ok(
      await scope.run<Envelope<PayableListDto['data']>>('payable.list', { party: 'member' }),
    ).data
    expect(members.groups.find((g) => g.partyId === admin.memberId)?.invoices).toEqual([
      expect.objectContaining({ kind: 'expense', documentId: taxi.id, outstanding: '42' }),
    ])
    const cash = await scope.spend(scope.expenseInput(category.id, day))
    const pay = (expenseId: string) => ({
      id: newId(),
      expenseId,
      businessDate: day,
      method: 'cash',
      amount: '1',
    })
    expect(codeOf(await scope.run('expensePayment.record', pay(cash.id)))).toBe('validation')
    const draft = await scope.expenseDraft(
      scope.expenseInput(category.id, day, {
        paymentMethod: 'paid_by_member',
        paidByMemberId: admin.memberId,
      }),
    )
    expect(codeOf(await scope.run('expensePayment.record', pay(draft.id)))).toBe(
      'document_not_posted',
    )
    expect(codeOf(await scope.run('expensePayment.record', pay(newId())))).toBe('not_found')
  })

  it('each kind for a member who may see its payments; a business without Purchases keeps the page', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const day = await scope.today()
    const category = (await scope.categories())[0]!
    const supplier = await scope.supplier()
    const milk = await scope.material()
    await scope.buy(
      purchaseInput(day, [line(milk.id, '1', '10')], {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    await scope.spend(
      scope.expenseInput(category.id, day, {
        supplierId: supplier.id,
        paymentMethod: 'supplier_credit',
      }),
    )
    const kindsFor = async (person: Person) => {
      const result = await scope.as<Envelope<PayableListDto['data']>>(person, 'payable.list', {
        party: 'supplier',
      })
      if (result.error) return result.error.data.appCode
      return result.data!.data.groups.flatMap((g) => g.invoices.map((i) => i.kind)).sort()
    }
    const person = async (overrides: { key: string; effect: 'allow' | 'deny' }[]) => {
      const p = await api.person()
      await addMember(api.db, scope.owner.user, scope.id, p.user, {
        template: 'manager',
        overrides,
      })
      return p
    }
    expect(await kindsFor(scope.owner)).toEqual(['expense', 'purchase'])
    expect(
      await kindsFor(await person([{ key: 'expenses.payments.view', effect: 'deny' }])),
    ).toEqual(['purchase'])
    expect(
      await kindsFor(await person([{ key: 'purchases.payments.view', effect: 'deny' }])),
    ).toEqual(['expense'])
    expect(
      await kindsFor(
        await person([
          { key: 'purchases.payments.view', effect: 'deny' },
          { key: 'expenses.payments.view', effect: 'deny' },
        ]),
      ),
    ).toBe('forbidden')
    // Supplier prices hidden: the list filters on amounts, so it is refused.
    expect(
      await kindsFor(await person([{ key: 'data.supplier_price.view', effect: 'deny' }])),
    ).toBe('forbidden')

    // Purchases turned off (a business that buys no materials): the expenses are still owed.
    ok(
      await scope.run('business.customize', {
        item: { kind: 'module', id: 'purchases' },
        enabled: false,
      }),
    )
    expect(await kindsFor(scope.owner)).toEqual(['expense'])
    expect(codeOf(await scope.run('purchasePayment.list', { purchaseId: newId() }))).toBe(
      'module_disabled',
    )
    // The books' date is read through Expenses too.
    ok(await scope.run('books.get'))
  })
})

// ---------------------------------------------------------------------------------------------------

describe('running costs (D-116)', () => {
  it('regular amounts turned into monthly amounts; the monthly total of those active today', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const day = await scope.today()
    const categories = await scope.categories()
    const named = (name: string) => categories.find((c) => c.name === name)!.id
    const input = (extra: object) => ({ id: newId(), startsOn: shift(day, -30), ...extra })
    const shopRent = await scope.runningCost(
      input({ name: 'Shop rent', categoryId: named('Rent'), amount: '15000' }),
    )
    expect(shopRent).toMatchObject({
      frequency: 'monthly',
      monthlyAmount: '15000',
      state: 'active',
      categoryName: 'Rent',
      endsOn: null,
    })
    const licence = await scope.runningCost(
      input({
        name: 'Trade licence',
        categoryId: named('Licences'),
        amount: '12000',
        frequency: 'yearly',
      }),
    )
    expect(licence.monthlyAmount).toBe('1000')
    const cleaning = await scope.runningCost(
      input({
        name: 'Cleaning',
        categoryId: named('Maintenance'),
        amount: '100',
        frequency: 'weekly',
      }),
    )
    expect(cleaning.monthlyAmount).toBe('433.333333333333')
    const upcoming = await scope.runningCost(
      input({
        name: 'New shop rent',
        categoryId: named('Rent'),
        amount: '18000',
        startsOn: shift(day, 10),
      }),
    )
    expect(upcoming.state).toBe('upcoming')
    const ended = await scope.runningCost(
      input({
        name: 'Old phone plan',
        categoryId: named('Phone'),
        amount: '300',
        endsOn: shift(day, -1),
      }),
    )
    expect(ended.state).toBe('ended')

    const list = ok(
      await scope.run<Envelope<RunningCostListDto['data']>>('runningCost.list', {}),
    ).data
    // 15 000 + 1 000 + 5 200 ÷ 12: only those active today.
    expect(list.monthlyTotal).toBe('16433.333333333333')
    expect(list).toMatchObject({ currency: 'AED', today: day })
    expect(list.items.map((i) => i.name)).toEqual([
      'Cleaning',
      'New shop rent',
      'Old phone plan',
      'Shop rent',
      'Trade licence',
    ])
    const only = async (filter: object) =>
      ok(
        await scope.run<Envelope<RunningCostListDto['data']>>('runningCost.list', filter),
      ).data.items.map((i) => i.name)
    expect(await only({ state: 'active' })).toEqual(['Cleaning', 'Shop rent', 'Trade licence'])
    expect(await only({ state: 'upcoming' })).toEqual(['New shop rent'])
    expect(await only({ state: 'ended' })).toEqual(['Old phone plan'])
    expect(await only({ categoryId: named('Rent') })).toEqual(['New shop rent', 'Shop rent'])
    expect(await only({ search: 'licen' })).toEqual(['Trade licence'])
    const page = ok(
      await scope.run<Envelope<RunningCostListDto['data']>>('runningCost.list', { limit: 2 }),
    ).data
    expect(page.items).toHaveLength(2)
    const rest = ok(
      await scope.run<Envelope<RunningCostListDto['data']>>('runningCost.list', {
        limit: 10,
        cursor: page.nextCursor,
      }),
    ).data
    expect(rest.items.map((i) => i.name)).toEqual(['Old phone plan', 'Shop rent', 'Trade licence'])

    // The rent goes up: the old one ends, the new one is edited to start the day after.
    const ends = ok(
      await scope.run<Envelope<RunningCostDto>>('runningCost.update', {
        id: shopRent.id,
        version: shopRent.version,
        name: shopRent.name,
        categoryId: shopRent.categoryId,
        amount: '15000',
        startsOn: shopRent.startsOn,
        endsOn: shift(day, 9),
      }),
    ).data
    expect(ends.endsOn).toBe(shift(day, 9))
    expect(
      codeOf(
        await scope.run('runningCost.update', {
          id: shopRent.id,
          version: shopRent.version,
          name: 'x',
          categoryId: shopRent.categoryId,
          amount: '1',
          startsOn: day,
        }),
      ),
    ).toBe('conflict')
    ok(await scope.run('runningCost.remove', { id: cleaning.id, version: cleaning.version }))
    expect(codeOf(await scope.run('runningCost.get', { id: cleaning.id }))).toBe('not_found')
    expect(
      codeOf(await scope.run('runningCost.remove', { id: cleaning.id, version: cleaning.version })),
    ).toBe('not_found')
    expect(
      ok(await scope.run<Envelope<RunningCostListDto['data']>>('runningCost.list', {})).data
        .monthlyTotal,
    ).toBe('16000')
  })

  it('refuses dates out of order, a zero amount and more decimals than the currency', async () => {
    const category = rent.id
    const base = { id: newId(), name: 'Bad', categoryId: category, amount: '10', startsOn: today }
    expect(codeOf(await shop.run('runningCost.create', { ...base, endsOn: yesterday }))).toBe(
      'validation',
    )
    expect(codeOf(await shop.run('runningCost.create', { ...base, amount: '0' }))).toBe(
      'validation',
    )
    expect(codeOf(await shop.run('runningCost.create', { ...base, amount: '10.001' }))).toBe(
      'validation',
    )
    expect(codeOf(await shop.run('runningCost.create', { ...base, frequency: 'daily' }))).toBe(
      'validation',
    )
    // Idempotent create.
    const created = await shop.runningCost({ ...base, id: newId(), name: 'Water' })
    const same = await shop.runningCost({ ...base, id: created.id, name: 'Water' })
    expect(same.id).toBe(created.id)
    expect(
      codeOf(await shop.run('runningCost.create', { ...base, id: created.id, name: 'Other' })),
    ).toBe('conflict')
  })
})

// ---------------------------------------------------------------------------------------------------

describe('who may see and do what', () => {
  it('the templates: Accountant sees; Employee enters and sends, without amounts; Sales sees nothing', async () => {
    const accountant = await api.member(shop, 'accountant')
    const employee = await api.member(shop, 'employee')
    const sales = await api.member(shop, 'sales')
    ok(await shop.as(accountant, 'expense.list'))
    ok(await shop.as(accountant, 'runningCost.list'))
    ok(await shop.as(accountant, 'costCategory.list'))
    expect(
      codeOf(await shop.as(accountant, 'expense.create', shop.expenseInput(rent.id, today))),
    ).toBe('forbidden')
    expect(
      codeOf(await shop.as(accountant, 'costCategory.create', { id: newId(), name: 'Mine' })),
    ).toBe('forbidden')
    for (const path of ['expense.list', 'runningCost.list', 'costCategory.list', 'payable.list']) {
      const input = path === 'payable.list' ? { party: 'supplier' } : undefined
      expect(codeOf(await shop.as(sales, path, input)), path).toBe('forbidden')
    }
    // The owner's answers of 2026-09-29 (D-180): an employee sees the expenses (amounts locked),
    // enters them and sends them for approval; never approves, finalizes, reverses or pays them, and
    // sees neither running costs nor what the business owes others.
    const seen = ok(await shop.as<Envelope<ExpenseListDto['data']>>(employee, 'expense.list'))
    expect(seen.meta.redacted).toEqual(['items.*.total'])
    ok(await shop.as(employee, 'costCategory.list'))
    const entered = ok(
      await shop.as<Envelope<ExpenseDto>>(
        employee,
        'expense.create',
        shop.expenseInput(rent.id, today),
      ),
    )
    expect(entered.meta.redacted).toContain('total')
    const version = { id: entered.data.id, version: entered.data.version }
    for (const [path, input] of [
      ['runningCost.list', undefined],
      ['payable.list', { party: 'member' }],
      ['expense.post', version],
      ['expense.approve', version],
      ['expense.reverse', { id: entered.data.id }],
      ['expensePayment.list', { expenseId: entered.data.id }],
      ['expense.updateSettings', { approval: true }],
    ] as const) {
      expect(codeOf(await shop.as(employee, path, input)), path).toBe('forbidden')
    }
    // An Employee allowed to see expenses sees them without amounts (a lock, never a 0).
    const viewer = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, viewer.user, {
      template: 'employee',
      overrides: [
        { key: 'expenses.documents.view', effect: 'allow' },
        { key: 'running_costs.items.view', effect: 'allow' },
      ],
    })
    const list = ok(await shop.as<Envelope<ExpenseListDto['data']>>(viewer, 'expense.list'))
    expect(list.meta.redacted).toEqual(['items.*.total'])
    expect(list.data.items.length).toBeGreaterThan(0)
    expect(list.data.items.every((i) => i.total === undefined)).toBe(true)
    const costs = ok(
      await shop.as<Envelope<RunningCostListDto['data']>>(viewer, 'runningCost.list'),
    )
    expect(costs.meta.redacted).toEqual(['items.*.amount', 'items.*.monthlyAmount', 'monthlyTotal'])
  })

  it('the modules stay unreleased: without the preview every procedure is MODULE_DISABLED', async () => {
    for (const path of [
      'expense.list',
      'runningCost.list',
      'costCategory.list',
      'expense.settings',
    ]) {
      const result = await api.call(shop.owner, shop.id, path, undefined, api.released)
      expect(codeOf(result), path).toBe('module_disabled')
    }
    const released = await api.call(
      shop.owner,
      shop.id,
      'payable.list',
      { party: 'supplier' },
      api.released,
    )
    expect(codeOf(released)).toBe('module_disabled')
    // The preview names them.
    expect(EXPENSES_PREVIEW).toContain('expenses')
    const onlyPurchases = handlerFor(api.db, undefined, {
      previewModules: ['materials', 'suppliers', 'purchases'],
    })
    expect(
      codeOf(await api.call(shop.owner, shop.id, 'costCategory.list', undefined, onlyPurchases)),
    ).toBe('module_disabled')
  })
})
