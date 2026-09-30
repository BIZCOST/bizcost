import type { CostCategoryDto, ExpenseDto } from '@bizcost/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { addMember } from './helpers'
import { codeOf, ok, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// M2 Step 5 security and money review, after the web screens (adversary pass on the review trail and
// on who may approve). Each test states what the rules promise; both findings were fixed with D-175
// (posting clears any rejection; reviewing needs supplier prices visible).
//   - D-164: "A rejected expense is edited like a draft (its first save makes it a draft again, the
//     reason kept until it is sent again)"; postExpense clears the rejection only when the expense is
//     still `rejected`, so an edited one that is finalized without being sent again stays "rejected"
//     (by, when, why) next to "approved" and "posted".
//   - D-164 / D-165: approval is "what was sent is what is approved", and expense amounts are supplier
//     prices; D-160 made recording a payment need supplier prices visible (its amount is checked
//     against them). Approving (or finalizing as the approver) has no such rule: a member who may
//     approve but not see supplier prices approves an amount the API hides from them.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let category: CostCategoryDto
/** Enters, sends and finalizes expenses and sees their amounts; may not approve. */
let clerk: Person
let manager: Person & { memberId: string }
/** May approve and finalize expenses, but not see supplier prices (a custom role). */
let blindApprover: Person

const CLERK_KEYS = [
  'expenses.documents.view',
  'expenses.documents.manage',
  'expenses.documents.post',
  'data.cost.view',
  'data.supplier_price.view',
] as const

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  category = await shop.category()
  clerk = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, clerk.user, {
    template: 'employee',
    overrides: CLERK_KEYS.map((key) => ({ key, effect: 'allow' as const })),
  })
  blindApprover = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, blindApprover.user, {
    template: 'employee',
    overrides: [
      { key: 'expenses.documents.view', effect: 'allow' },
      { key: 'expenses.documents.approve', effect: 'allow' },
      { key: 'expenses.documents.post', effect: 'allow' },
    ],
  })
  manager = await api.member(shop, 'manager')
  ok(await shop.run('expense.updateSettings', { approval: true }))
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** A draft the clerk entered in `scope` and sent for approval. */
async function sentByClerk(scope: ExpenseScope, categoryId: string, amount: string) {
  const draft = ok(
    await scope.as<Envelope<ExpenseDto>>(
      clerk,
      'expense.create',
      scope.expenseInput(categoryId, today, { amount }),
    ),
  ).data
  return ok(
    await scope.as<Envelope<ExpenseDto>>(clerk, 'expense.submit', {
      id: draft.id,
      version: draft.version,
    }),
  ).data
}

/** Rejected by `reviewer` with a reason, then edited by the clerk (a draft again, D-164). */
async function rejectedThenEdited(
  scope: ExpenseScope,
  reviewer: Person,
  categoryId: string,
): Promise<ExpenseDto> {
  const sent = await sentByClerk(scope, categoryId, '300')
  const rejected = ok(
    await scope.as<Envelope<ExpenseDto>>(reviewer, 'expense.reject', {
      id: sent.id,
      version: sent.version,
      reason: 'Wrong amount: the bill says 30',
    }),
  ).data
  const edited = ok(
    await scope.as<Envelope<ExpenseDto>>(clerk, 'expense.update', {
      ...scope.expenseInput(categoryId, today, { amount: '30' }),
      id: rejected.id,
      version: rejected.version,
    }),
  ).data
  expect(edited.status).toBe('draft')
  return edited
}

describe('a final expense does not stay "rejected" (D-164 review trail)', () => {
  it('fixed after a rejection and finalized by the approver: approved, never also rejected', async () => {
    const edited = await rejectedThenEdited(shop, manager, category.id)
    // The approver looks at the corrected draft and finalizes it directly (their approval is
    // recorded with the posting, D-164).
    const posted = ok(
      await shop.as<Envelope<ExpenseDto>>(manager, 'expense.post', {
        id: edited.id,
        version: edited.version,
      }),
    ).data
    expect(posted.status).toBe('posted')
    expect(posted.approvedBy?.memberId).toBe(manager.memberId)
    // Never "approved by the manager" and "rejected by the manager: Wrong amount" on one final
    // expense: posting clears the rejection of the draft the edit made of it too.
    expect(posted.rejectedAt).toBeNull()
    expect(posted.rejectedBy).toBeNull()
    expect(posted.rejectionReason).toBeNull()
  })

  it('fixed after a rejection, approval turned off, finalized by the one who entered it', async () => {
    const scope = await ExpenseScope.open(api, WORKSHOP)
    const own = await scope.category()
    await addMember(api.db, scope.owner.user, scope.id, clerk.user, {
      template: 'employee',
      overrides: CLERK_KEYS.map((key) => ({ key, effect: 'allow' as const })),
    })
    ok(await scope.run('expense.updateSettings', { approval: true }))
    const edited = await rejectedThenEdited(scope, scope.owner, own.id)
    ok(await scope.run('expense.updateSettings', { approval: false }))
    const posted = ok(
      await scope.as<Envelope<ExpenseDto>>(clerk, 'expense.post', {
        id: edited.id,
        version: edited.version,
      }),
    ).data
    expect(posted.status).toBe('posted')
    // A final expense that nobody approved reads "rejected by the owner" (with the reason) for good.
    expect(posted.rejectedAt).toBeNull()
    expect(posted.rejectionReason).toBeNull()
  })
})

describe('what was sent is what is approved (D-164): the approver must see it (D-165, D-160)', () => {
  it('a member who may not see supplier prices cannot approve an amount hidden from them', async () => {
    const sent = await sentByClerk(shop, category.id, '9000')
    const seen = ok(
      await shop.as<Envelope<ExpenseDto>>(blindApprover, 'expense.get', { id: sent.id }),
    )
    // What they are asked to approve: every amount is removed.
    expect(seen.meta.redacted).toEqual(
      expect.arrayContaining(['amount', 'netTotal', 'vatTotal', 'total']),
    )
    // Approving the 9 000 unseen is refused, as recording a payment is (D-160, D-175).
    const approved = await shop.as(blindApprover, 'expense.approve', {
      id: sent.id,
      version: seen.data.version,
    })
    expect(codeOf(approved)).toBe('forbidden')
  })

  it('nor finalize a draft as its approver (their approval recorded with the posting)', async () => {
    const draft = ok(
      await shop.as<Envelope<ExpenseDto>>(
        clerk,
        'expense.create',
        shop.expenseInput(category.id, today, { amount: '7777' }),
      ),
    ).data
    // With approval on, a draft is posted only by a member who may approve (D-164), and their
    // approval is recorded with it: never for 7 777 they cannot see (D-175). Since D-200 approving
    // needs supplier prices, so the key this member was given grants nothing: they are a member who
    // may not approve, and the draft needs approval first.
    const posted = await shop.as(blindApprover, 'expense.post', {
      id: draft.id,
      version: draft.version,
    })
    expect(codeOf(posted)).toBe('approval_required')
    const still = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: draft.id })).data
    expect(still).toMatchObject({ status: 'draft', approvedAt: null, postedAt: null })
  })
})
