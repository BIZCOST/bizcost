import type { ExpenseStatus } from './keys'

// What can be done with an expense in each status (M2 Step 5; PRODUCT.md §4 rule 13, D-164). The API
// applies it under the expense's row lock; the web asks the same function which actions to offer.
//
//   draft ──submit──► submitted ──approve──► approved ──post──► posted ──reverse──► reversed
//     ▲  │                │  └───reject──► rejected ◄──reject──┘
//     │  └──post (approval off, or by a member who may approve)──► posted
//     └── update (a rejected expense edited is a draft again) ◄── rejected
//
// Approval applies only while the business requires it (the setting, with a team). Without it an
// expense goes from draft to posted, and one already sent for approval can still be approved,
// rejected or posted. With it, a member who may approve posts a draft or a submitted expense directly
// (their approval is recorded with the posting); anyone else sends it for approval first.
// A submitted or approved expense is never changed (its amounts are what was approved): it is
// rejected to be changed. Posting and reversing again are no-ops (idempotent), as are submitting,
// approving and rejecting what already is so.

export const EXPENSE_ACTIONS = [
  'update',
  'discard',
  'submit',
  'approve',
  'reject',
  'post',
  'reverse',
] as const
export type ExpenseAction = (typeof EXPENSE_ACTIONS)[number]

/** Why an action is refused; each is an API error code of the same name. */
export type ExpenseRefusal =
  | 'document_posted'
  | 'document_not_posted'
  | 'expense_in_approval'
  | 'expense_not_submitted'
  | 'approval_required'
  | 'approval_off'

export interface ExpenseActionContext {
  readonly status: ExpenseStatus
  /** The business requires approval now (its setting is on and it has a team). */
  readonly approvalRequired: boolean
  /** The member may approve expenses (expenses.documents.approve). */
  readonly mayApprove: boolean
}

export type ExpenseTransition =
  | {
      readonly ok: true
      /** The status after the action. */
      readonly to: ExpenseStatus
      /** False when the expense already is where the action leads (nothing to write). */
      readonly changes: boolean
    }
  | { readonly ok: false; readonly refusal: ExpenseRefusal }

const to = (status: ExpenseStatus, changes = true): ExpenseTransition => ({
  ok: true,
  to: status,
  changes,
})
const refuse = (refusal: ExpenseRefusal): ExpenseTransition => ({ ok: false, refusal })

const EDITABLE: readonly ExpenseStatus[] = ['draft', 'rejected']
const IN_APPROVAL: readonly ExpenseStatus[] = ['submitted', 'approved']
const FINAL: readonly ExpenseStatus[] = ['posted', 'reversed']

/** Where `action` takes an expense in `ctx`, or why it is refused. */
export function expenseTransition(
  action: ExpenseAction,
  ctx: ExpenseActionContext,
): ExpenseTransition {
  const { status } = ctx
  switch (action) {
    case 'update':
    case 'discard':
      if (EDITABLE.includes(status)) return to('draft')
      if (IN_APPROVAL.includes(status)) return refuse('expense_in_approval')
      return refuse('document_posted')
    case 'submit':
      if (FINAL.includes(status)) return refuse('document_posted')
      if (IN_APPROVAL.includes(status)) return to(status, false)
      if (!ctx.approvalRequired) return refuse('approval_off')
      return to('submitted')
    case 'approve':
      if (FINAL.includes(status)) return refuse('document_posted')
      if (status === 'approved') return to('approved', false)
      if (status !== 'submitted') return refuse('expense_not_submitted')
      return to('approved')
    case 'reject':
      if (FINAL.includes(status)) return refuse('document_posted')
      if (status === 'rejected') return to('rejected', false)
      if (!IN_APPROVAL.includes(status)) return refuse('expense_not_submitted')
      return to('rejected')
    case 'post':
      if (FINAL.includes(status)) return to(status, false)
      if (status === 'approved') return to('posted')
      if (ctx.approvalRequired && !ctx.mayApprove) return refuse('approval_required')
      return to('posted')
    case 'reverse':
      if (status === 'reversed') return to('reversed', false)
      if (status !== 'posted') return refuse('document_not_posted')
      return to('reversed')
  }
}

/**
 * The actions that would change the expense in `ctx` (what the web offers). Permissions other than
 * approving (entering, posting, reversing) are the caller's to check.
 */
export function expenseActions(ctx: ExpenseActionContext): ExpenseAction[] {
  return EXPENSE_ACTIONS.filter((action) => {
    const transition = expenseTransition(action, ctx)
    return transition.ok && transition.changes
  })
}
