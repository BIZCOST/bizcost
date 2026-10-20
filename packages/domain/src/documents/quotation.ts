// Quotations (M3 Step 7; the owner's answers Q21–Q25 of D-218). A quotation is numbered when it is
// created (document_counters `quotation`, Q-0001…, which may skip: a discarded draft keeps its number)
// and goes through revisions under that number:
//
//   draft ──send──► sent ──accept──► accepted ──to_order──► (its order)
//     ▲  │             └──decline──► declined
//     │  └─discard (only a draft; its number is not given back)
//     └──────── revise (of the latest sent, accepted or declined revision): revision n + 1, a draft
//
// A revision is frozen once sent (a database trigger refuses any other change): "Revise" makes the next
// revision, and once that one is sent the one before is kept as `superseded`. Sending, accepting and
// declining again are no-ops (a repeated call returns the recorded result). "Expired" is no status: a
// sent quotation whose `valid_until` has passed shows as expired, and can still be accepted. "Copy"
// starts a new quotation (a new number) from any revision. Extra work on an accepted quotation is a new
// revision, accepted again (Q22); only one revision of a quotation becomes an order.
//
// The API applies quotationTransition under the quotation's row lock; the web asks quotationActions
// which actions to offer (the caller's keys are its own business).

/** `quotations.status`. */
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'superseded'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]

/** How a quotation shows in a list: its status, or `expired` for a sent one past its validity. */
export const QUOTATION_LIST_STATUSES = [...QUOTATION_STATUSES, 'expired'] as const
export type QuotationListStatus = (typeof QUOTATION_LIST_STATUSES)[number]

export const QUOTATION_ACTIONS = [
  'update',
  'discard',
  'send',
  'revise',
  'accept',
  'decline',
  'copy',
  'to_order',
] as const
export type QuotationAction = (typeof QUOTATION_ACTIONS)[number]

/** Why an action is refused; each is an API error code of the same name. */
export type QuotationRefusal =
  /** Not a draft: a sent revision is frozen (revise it instead). */
  | 'quotation_frozen'
  /** Accepting or declining needs a sent revision; revising needs one that was sent. */
  | 'quotation_not_sent'
  /** A newer revision exists: act on the latest one. */
  | 'quotation_superseded'
  /** Already declined (to accept) or accepted (to decline). */
  | 'quotation_decided'
  /** An order is made only from an accepted revision. */
  | 'quotation_not_accepted'
  /** Another revision of this quotation became an order already. */
  | 'quotation_has_order'
  /** An issued invoice bills a revision of this quotation: it is invoiced from here on (M3 Step 8). */
  | 'quotation_invoiced'

export interface QuotationActionContext {
  readonly status: QuotationStatus
  /** This revision is the latest of its quotation (a draft revision counts). */
  readonly latest: boolean
  /** This revision became an order (`order_id`). */
  readonly hasOrder: boolean
  /** Another revision of the same quotation became an order. */
  readonly otherHasOrder: boolean
  /**
   * An issued invoice bills a revision of this quotation (a deposit or a stage): it is invoiced from
   * the quotation to the end, never made an order (the work would be billed and counted twice, Q3).
   */
  readonly invoiced?: boolean
}

export type QuotationTransition =
  | {
      readonly ok: true
      /** The status after the action (a new draft for `revise` and `copy`). */
      readonly to: QuotationStatus
      /** False when nothing is written (the action already happened). */
      readonly changes: boolean
    }
  | { readonly ok: false; readonly refusal: QuotationRefusal }

const to = (status: QuotationStatus, changes = true): QuotationTransition => ({
  ok: true,
  to: status,
  changes,
})
const refuse = (refusal: QuotationRefusal): QuotationTransition => ({ ok: false, refusal })

/** Where `action` takes a revision in `ctx`, or why it is refused. */
export function quotationTransition(
  action: QuotationAction,
  ctx: QuotationActionContext,
): QuotationTransition {
  const { status } = ctx
  switch (action) {
    case 'update':
    case 'discard':
      return status === 'draft' ? to('draft') : refuse('quotation_frozen')
    case 'send':
      return status === 'draft' ? to('sent') : to(status, false)
    case 'revise':
      if (status === 'draft') return refuse('quotation_not_sent')
      if (status === 'superseded' || !ctx.latest) return refuse('quotation_superseded')
      return to('draft')
    case 'accept':
      if (status === 'accepted') return to('accepted', false)
      if (status === 'draft') return refuse('quotation_not_sent')
      if (status === 'superseded') return refuse('quotation_superseded')
      if (status === 'declined') return refuse('quotation_decided')
      return to('accepted')
    case 'decline':
      if (status === 'declined') return to('declined', false)
      if (status === 'draft') return refuse('quotation_not_sent')
      if (status === 'superseded') return refuse('quotation_superseded')
      if (status === 'accepted')
        return refuse(ctx.hasOrder ? 'quotation_has_order' : 'quotation_decided')
      return to('declined')
    case 'copy':
      return to('draft')
    case 'to_order':
      if (ctx.hasOrder) return to(status, false)
      if (status !== 'accepted') return refuse('quotation_not_accepted')
      if (ctx.otherHasOrder) return refuse('quotation_has_order')
      if (ctx.invoiced) return refuse('quotation_invoiced')
      return to('accepted')
  }
}

/** The actions that would change the revision in `ctx` (what the web offers). */
export function quotationActions(ctx: QuotationActionContext): QuotationAction[] {
  return QUOTATION_ACTIONS.filter((action) => {
    const transition = quotationTransition(action, ctx)
    return transition.ok && transition.changes
  })
}

/**
 * How a revision shows in a list: `expired` for a sent one whose validity ended before `today`
 * (YYYY-MM-DD; a quotation valid until today is still valid today), else its status.
 */
export function quotationListStatus(
  status: QuotationStatus,
  validUntil: string | null,
  today: string,
): QuotationListStatus {
  return status === 'sent' && validUntil !== null && validUntil < today ? 'expired' : status
}

/** Days a new quotation is valid for, until the business sets its own (Settings → Documents). */
export const QUOTATION_VALID_DAYS_DEFAULT = 30

/** The most days a business may make its quotations valid for. */
export const QUOTATION_VALID_DAYS_MAX = 365

// ---------------------------------------------------------------------------------------------------
// The letterhead (the owner's request of 2026-10-16: «بحسب اسم ومعلومات كل شركة»)
// ---------------------------------------------------------------------------------------------------

/**
 * The accent colours a business may pick for its documents' letterhead (Settings → Documents): calm,
 * printable on white, each dark enough for white text on it (contrast ≥ 4.5:1). Stored as the key;
 * the PDF template gets the hex.
 */
export const DOCUMENT_ACCENTS = {
  navy: '#0B4F8F',
  black: '#1A1A1A',
  teal: '#0F6E6E',
  green: '#2E6B3A',
  maroon: '#7A2331',
  brown: '#7A4E1D',
  slate: '#3D4A5C',
} as const
export type DocumentAccent = keyof typeof DOCUMENT_ACCENTS
export const DOCUMENT_ACCENT_KEYS = Object.keys(DOCUMENT_ACCENTS) as DocumentAccent[]

/** The accent of a business that has not picked one. */
export const DOCUMENT_ACCENT_DEFAULT: DocumentAccent = 'navy'

export function isDocumentAccent(value: unknown): value is DocumentAccent {
  return typeof value === 'string' && Object.hasOwn(DOCUMENT_ACCENTS, value)
}
