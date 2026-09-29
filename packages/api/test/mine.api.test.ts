import type {
  BusinessContextDto,
  CostCategoryDto,
  ExpenseDto,
  ExpenseListDto,
  MineExpenseListDto,
  MineExpenseResultDto,
  MinePayableListDto,
  PurchaseDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { handlerFor } from './helpers'
import { codeOf, line, ok, purchaseInput, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// The owner's answers of 2026-09-29 (A3, A4; D-180, D-181), through the real fetch handler with the
// modules previewed:
//   - an employee (the template, no supplier prices) enters expenses and sends them for approval;
//     with approval off their draft waits for someone who may finalize it;
//   - a member sees the amounts of their own records ("My expenses": expense.mine, expense.getMine)
//     and what the business owes them and paid them back ("Owed to me": payable.mine), even without
//     supplier prices; everything else stays redacted or refused as before, and nobody else's
//     amounts ever reach these procedures;
//   - business.context gives a member who is owed "Amounts owed" without its keys.

let api: ExpensesApi
let team: ExpenseScope
let today: string
let category: CostCategoryDto
let manager: Person & { memberId: string }
let employee: Person & { memberId: string }
let other: Person & { memberId: string }

beforeAll(async () => {
  api = new ExpensesApi()
  team = await ExpenseScope.open(api, WORKSHOP)
  today = await team.today()
  category = (await team.categories()).find((c) => c.name === 'Maintenance')!
  manager = await api.member(team, 'manager')
  employee = await api.member(team, 'employee')
  other = await api.member(team, 'employee')
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** An expense paid by `payer` from their own money: 100 before 5 % VAT, 105 in all. */
function paidBy(payer: { memberId: string }, extra: object = {}) {
  return team.expenseInput(category.id, today, {
    paymentMethod: 'paid_by_member',
    paidByMemberId: payer.memberId,
    description: 'Fixing the door',
    ...extra,
  })
}

async function mine(person: Person, input?: object) {
  return ok(await team.as<MineExpenseListDto>(person, 'expense.mine', input))
}

async function owedToMe(person: Person, input?: object) {
  return ok(await team.as<MinePayableListDto>(person, 'payable.mine', input))
}

async function navOf(person: Person, businessId = team.id): Promise<string[]> {
  const context = ok(
    await api.call<BusinessContextDto>(person, businessId, 'business.context', undefined),
  )
  return context.modules.flatMap((m) => m.nav.map((e) => e.id))
}

describe('an employee enters an expense and sends it for approval (D-180)', () => {
  let sent: ExpenseDto

  beforeAll(async () => {
    ok(await team.run('expense.updateSettings', { approval: true }))
  })

  afterAll(async () => {
    ok(await team.run('expense.updateSettings', { approval: false }))
  })

  it('the template enters and sends it; the amount is hidden everywhere but in their own records', async () => {
    const created = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.create', paidBy(employee)),
    )
    // The general view hides the amounts (supplier prices), as before.
    expect(created.meta.redacted).toEqual(['amount', 'costTotal', 'netTotal', 'total', 'vatTotal'])
    expect(created.data.total).toBeUndefined()
    const submitted = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.submit', {
        id: created.data.id,
        version: created.data.version,
      }),
    )
    sent = submitted.data
    expect(sent.status).toBe('submitted')
    // Never approves or finalizes it.
    const version = { id: sent.id, version: sent.version }
    expect(codeOf(await team.as(employee, 'expense.approve', version))).toBe('forbidden')
    expect(codeOf(await team.as(employee, 'expense.post', version))).toBe('forbidden')

    // "My expenses": the amount they typed, and who they are to it.
    const own = await mine(employee)
    expect(own.items).toEqual([
      expect.objectContaining({
        id: sent.id,
        status: 'submitted',
        categoryName: 'Maintenance',
        description: 'Fixing the door',
        enteredByMe: true,
        paidByMe: true,
        total: '105',
        paid: null,
        outstanding: null,
      }),
    ])
    const one = ok(
      await team.as<MineExpenseResultDto>(employee, 'expense.getMine', { id: sent.id }),
    )
    expect(one.meta.redacted).toEqual([])
    expect(one.data).toMatchObject({
      id: sent.id,
      amount: '100',
      netTotal: '100',
      vatTotal: '5',
      total: '105',
      status: 'submitted',
      version: sent.version,
    })
    // expense.get still hides it from them.
    const got = ok(await team.as<Envelope<ExpenseDto>>(employee, 'expense.get', { id: sent.id }))
    expect(got.data.total).toBeUndefined()
  })

  it('approved and final, it is owed to them; they see what was paid back', async () => {
    const approved = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.approve', {
        id: sent.id,
        version: sent.version,
      }),
    ).data
    ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.post', {
        id: approved.id,
        version: approved.version,
      }),
    )
    expect((await mine(employee)).items[0]).toMatchObject({
      status: 'posted',
      paid: '0',
      outstanding: '105',
    })
    const before = await owedToMe(employee)
    expect(before).toMatchObject({ outstanding: '105', owedCount: 1, paidBack: '0' })
    expect(before.items).toEqual([
      expect.objectContaining({
        kind: 'expense',
        documentId: sent.id,
        categoryName: 'Maintenance',
        itemNames: ['Fixing the door'],
        total: '105',
        paid: '0',
        outstanding: '105',
        payments: [],
      }),
    ])
    // The manager pays 40 back.
    const payment = newId()
    ok(
      await team.as(manager, 'expensePayment.record', {
        id: payment,
        expenseId: sent.id,
        businessDate: today,
        method: 'cash',
        amount: '40',
      }),
    )
    const after = await owedToMe(employee)
    expect(after).toMatchObject({ outstanding: '65', owedCount: 1, paidBack: '40' })
    expect(after.items[0]?.payments).toEqual([
      { id: payment, businessDate: today, method: 'cash', amount: '40' },
    ])
    expect((await mine(employee)).items[0]).toMatchObject({ paid: '40', outstanding: '65' })
    // The rest of what is owed is paid: nothing is owed any more, and it stays listed as paid back.
    ok(
      await team.as(manager, 'expensePayment.record', {
        id: newId(),
        expenseId: sent.id,
        businessDate: today,
        method: 'bank_transfer',
        amount: '65',
      }),
    )
    const settled = await owedToMe(employee)
    expect(settled).toMatchObject({ outstanding: '0', owedCount: 0, paidBack: '105' })
    expect(settled.items[0]).toMatchObject({ outstanding: '0', paid: '105' })
    expect(settled.items[0]?.payments).toHaveLength(2)
  })

  it('the general views stay refused or redacted for them', async () => {
    expect(codeOf(await team.as(employee, 'payable.list', { party: 'member' }))).toBe('forbidden')
    expect(codeOf(await team.as(employee, 'expensePayment.list', { expenseId: sent.id }))).toBe(
      'forbidden',
    )
    const list = ok(await team.as<Envelope<ExpenseListDto['data']>>(employee, 'expense.list'))
    expect(list.meta.redacted).toEqual(['items.*.total'])
    expect(list.data.items.find((i) => i.id === sent.id)?.total).toBeUndefined()
  })
})

describe('with approval off, an employee’s draft waits for someone who may finalize it (D-180)', () => {
  it('sending is APPROVAL_OFF, finalizing FORBIDDEN; a manager finalizes it', async () => {
    const draft = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.create', paidBy(employee)),
    ).data
    const version = { id: draft.id, version: draft.version }
    expect(codeOf(await team.as(employee, 'expense.submit', version))).toBe('approval_off')
    expect(codeOf(await team.as(employee, 'expense.post', version))).toBe('forbidden')
    // Still theirs to change: it opens with its amounts in their own records.
    const own = ok(
      await team.as<MineExpenseResultDto>(employee, 'expense.getMine', { id: draft.id }),
    ).data
    const updated = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.update', {
        ...paidBy(employee, { amount: '120' }),
        id: own.id,
        version: own.version,
      }),
    ).data
    // Who may finalize it hears that a draft of the team waits (`enteredBy: 'others'`, D-184); its
    // own drafts are not in that list.
    const waiting = ok(
      await team.as<ExpenseListDto>(manager, 'expense.list', {
        status: 'draft',
        enteredBy: 'others',
        limit: 100,
      }),
    ).data.items.map((item) => item.id)
    expect(waiting).toContain(draft.id)
    const byEmployee = ok(
      await team.as<ExpenseListDto>(employee, 'expense.list', {
        status: 'draft',
        enteredBy: 'others',
        limit: 100,
      }),
    ).data.items.map((item) => item.id)
    expect(byEmployee).not.toContain(draft.id)
    const posted = ok(
      await team.as<Envelope<ExpenseDto>>(manager, 'expense.post', {
        id: updated.id,
        version: updated.version,
      }),
    ).data
    expect(posted).toMatchObject({ status: 'posted', total: '126' })
  })

  it('an employee changes only their own drafts and receipts, never another member’s (D-184)', async () => {
    const theirs = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.create', paidBy(employee)),
    ).data
    const version = { id: theirs.id, version: theirs.version }
    // The other employee (no supplier prices) sees it exists, and may not touch it.
    expect(codeOf(await team.as(other, 'expense.update', { ...paidBy(other), ...version }))).toBe(
      'forbidden',
    )
    expect(codeOf(await team.as(other, 'expense.discard', version))).toBe('forbidden')
    const upload = { entity: 'expense', entityId: theirs.id, contentType: 'image/png' }
    expect(codeOf(await team.as(other, 'attachment.uploadUrl', upload))).toBe('forbidden')
    // Its own employee may: a receipt, then taking it out.
    ok(await team.as(employee, 'attachment.uploadUrl', upload))
    ok(await team.as(employee, 'expense.discard', version))
    // A manager (who sees supplier prices) changes anyone's, as before.
    const again = ok(
      await team.as<Envelope<ExpenseDto>>(employee, 'expense.create', paidBy(employee)),
    ).data
    ok(await team.as(manager, 'expense.discard', { id: again.id, version: again.version }))
  })
})

describe('their own records only: nobody else’s amounts (D-181)', () => {
  it('an expense the owner entered and paid is not theirs: absent from mine, NOT_FOUND by id', async () => {
    const owners = await team.spend(
      team.expenseInput(category.id, today, { amount: '987.65', description: 'Owner only' }),
    )
    for (const person of [employee, other]) {
      const listed = await team.as<MineExpenseListDto>(person, 'expense.mine', { limit: 100 })
      expect(ok(listed).items.some((i) => i.id === owners.id)).toBe(false)
      expect(listed.raw.includes('987.65')).toBe(false)
      const one = await team.as(person, 'expense.getMine', { id: owners.id })
      expect(codeOf(one)).toBe('not_found')
      expect(one.raw.includes('987.65')).toBe(false)
    }
  })

  it('the owner’s own list says which they only entered (paid in cash: not paid by them)', async () => {
    const listed = (await mine(team.owner, { limit: 100 })).items
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.some((i) => i.enteredByMe && !i.paidByMe)).toBe(true)
    expect(listed.every((i) => typeof i.paidByMe === 'boolean')).toBe(true)
  })

  it('one entered by someone else and paid by them is theirs (paid by me), not the other employee’s', async () => {
    const forEmployee = await team.spend(paidBy(employee, { amount: '11.11', vatRate: '0' }))
    const seen = (await mine(employee, { limit: 100 })).items.find((i) => i.id === forEmployee.id)
    expect(seen).toMatchObject({ enteredByMe: false, paidByMe: true, total: '11.11' })
    ok(await team.as(employee, 'expense.getMine', { id: forEmployee.id }))
    // The other employee sees none of it, nor of the first employee's own expenses.
    const others = await team.as<MineExpenseListDto>(other, 'expense.mine', { limit: 100 })
    expect(ok(others).items).toEqual([])
    expect(others.raw.includes('11.11')).toBe(false)
    expect(codeOf(await team.as(other, 'expense.getMine', { id: forEmployee.id }))).toBe(
      'not_found',
    )
    const owed = await team.as<MinePayableListDto>(other, 'payable.mine')
    expect(ok(owed)).toMatchObject({ outstanding: '0', owedCount: 0, paidBack: '0', items: [] })
    expect(owed.raw.includes('11.11')).toBe(false)
  })

  it('pages with a cursor as the lists do; a cursor it did not make is VALIDATION', async () => {
    const first = await mine(employee, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = await mine(employee, { limit: 1, cursor: first.nextCursor })
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    const owed = await owedToMe(employee, { limit: 1 })
    expect(owed.items).toHaveLength(1)
    const next = await owedToMe(employee, { limit: 1, cursor: owed.nextCursor })
    expect(next.items[0]?.documentId).not.toBe(owed.items[0]?.documentId)
    // Totals cover every page.
    expect(next.paidBack).toBe(owed.paidBack)
    for (const path of ['expense.mine', 'payable.mine']) {
      expect(codeOf(await team.as(employee, path, { cursor: 'bm90LWEtY3Vyc29y' })), path).toBe(
        'validation',
      )
    }
  })
})

describe('Owed to me for a purchase, and the "Amounts owed" entry (D-181)', () => {
  it('a member without purchase keys (Sales) who paid a purchase sees it and what was paid back', async () => {
    const sales = await api.member(team, 'sales')
    expect(await navOf(sales)).not.toContain('payables')
    const milk = await team.material()
    const draft = await team.draft(
      purchaseInput(today, [line(milk.id, '3', '4.25')], {
        paymentMethod: 'paid_by_member',
        paidByMemberId: sales.memberId,
      }),
    )
    // A draft is not owed yet.
    expect((await owedToMe(sales)).items).toEqual([])
    const posted: PurchaseDto = await team.post(draft)
    expect(await navOf(sales)).toContain('payables')
    const owed = await owedToMe(sales)
    expect(owed).toMatchObject({ outstanding: '12.75', owedCount: 1 })
    expect(owed.items[0]).toMatchObject({
      kind: 'purchase',
      documentId: posted.id,
      total: '12.75',
      returned: '0',
      outstanding: '12.75',
      categoryName: null,
    })
    // Nothing else of purchases opens to them.
    expect(codeOf(await team.as(sales, 'purchase.get', { id: posted.id }))).toBe('forbidden')
    expect(codeOf(await team.as(sales, 'payable.list', { party: 'member' }))).toBe('forbidden')
    // Paid back in full: still listed, owed nothing.
    ok(
      await team.run('purchasePayment.record', {
        id: newId(),
        purchaseId: posted.id,
        businessDate: today,
        method: 'cash',
        amount: '12.75',
      }),
    )
    expect(await owedToMe(sales)).toMatchObject({ outstanding: '0', paidBack: '12.75' })
    expect(await navOf(sales)).toContain('payables')
  })

  it('the entry comes once, and not to a member the business owes nothing', async () => {
    const nav = await navOf(employee)
    expect(nav.filter((id) => id === 'payables')).toHaveLength(1)
    expect(await navOf(other)).not.toContain('payables')
    // Members who reach it by their keys keep it as before.
    expect(await navOf(manager)).toContain('payables')
  })

  it('needs Purchases or Expenses on: each kind only with its module; released code has neither', async () => {
    const expensesOnly = handlerFor(api.db, undefined, {
      previewModules: ['materials', 'products', 'suppliers', 'expenses'],
    })
    const kinds = ok(
      await api.call<MinePayableListDto>(employee, team.id, 'payable.mine', {}, expensesOnly),
    ).items.map((i) => i.kind)
    expect(new Set(kinds)).toEqual(new Set(['expense']))
    for (const path of ['payable.mine', 'expense.mine']) {
      expect(codeOf(await api.call(employee, team.id, path, {}, api.released)), path).toBe(
        'module_disabled',
      )
    }
  })

  it('My expenses needs "see expenses" (Sales has none); Owed to me needs no key', async () => {
    const sales = await api.member(team, 'sales')
    expect(codeOf(await team.as(sales, 'expense.mine'))).toBe('forbidden')
    ok(await team.as(sales, 'payable.mine'))
  })
})
