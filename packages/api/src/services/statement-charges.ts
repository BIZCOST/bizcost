import type { StatementEntryKind } from '@bizcost/contracts'
import {
  compareDecimal,
  subtractDecimals,
  sumDecimals,
  type SettlementMethod,
} from '@bizcost/domain'

// What each entry of a customer's statement adds or takes off on its own day (statements.ts, D-313):
// pure, so that a past day's entries are shown never to change whatever comes after.

/** An entry as read (statements.ts `entriesSql`). */
export interface EntryRecord extends Record<string, unknown> {
  date: string
  kind: StatementEntryKind
  id: string
  number: string | null
  reference: string | null
  charge: string
  credit: string
  paid_when_made: boolean
  created_at: Date | string
  item_names: string[]
  method: SettlementMethod | null
  /** The order or sale whose own charge it may change (an invoice's, a credit note's, its own). */
  src_kind: 'order' | 'sale' | null
  src_id: string | null
  /** That order's number. */
  src_number: string | null
  /** A credit note that only billed less (D-305): its order bills it again. */
  bills_less: boolean
  /**
   * It undoes an earlier entry on a later day (the books closed on that entry's day, D-334): a sale
   * reversed (a credit), a refund or a payment reversed (a charge), money given back reversed (a credit).
   */
  reversal: boolean
}

/** An entry with what it adds or takes off on its own day (`ownCharges`). */
export interface StatementRow extends EntryRecord {
  owedThrough: { amount: string; orderNumber: string | null } | null
}

/** An order's or a sale's own charge, day by day (`ownCharges`). */
interface SourceState {
  kind: 'order' | 'sale'
  /** An order's payable, a sale's total. */
  base: string
  /** The order delivered, the sale made. */
  open: boolean
  /** What the order's issued invoices still bill: their payable less the credit notes that only billed less. */
  billed: string
  /** The sale's refunds that stand (their own entries take them off). */
  refunded: string
  /** The sale has an issued invoice: it owes nothing of its own any more (A2). */
  invoiced: boolean
  /** What it owes of its own so far: its entry's charge, less what its invoices carried off since. */
  own: string
}

const atLeastZero = (value: string) => (compareDecimal(value, '0') < 0 ? '0' : value)

/** What a source's own entry charges by the end of a day (net of what its invoices carried off). */
function ownOf(s: SourceState): string {
  if (!s.open) return '0'
  if (s.kind === 'order') return atLeastZero(subtractDecimals(s.base, s.billed))
  // A sale's refunds are entries of their own (they take themselves off); once it is invoiced, its
  // invoices carry all it still owed, so what is left of its entry is what its refunds take off.
  return s.invoiced ? s.refunded : s.base
}

/**
 * Each entry's charge or credit as it stood at the end of its day (`rows` by day, then time; a period
 * is whole days). A delivered order charges on its delivery day what its issued invoices did not bill
 * by the end of it (D-313), and a sale "they'll pay later" its total on its day unless invoiced that
 * day (their invoices of that day charge in full). On a later day an invoice adds only what they did
 * not charge (the rest is `owedThrough` them), and a credit note that only billed less (D-305) takes
 * off only what its order does not owe again. So no entry changes once its day is over (an invoice
 * issued later never moves a delivered order out of an earlier period), owed at the start of a period
 * is owed at the end of the one before, and owed at the end is What customers owe's figure; an order
 * or a sale invoiced on its own day is listed through its invoices only.
 */
export function ownCharges(rows: readonly EntryRecord[]): StatementRow[] {
  const sources = new Map<string, SourceState>()
  const out: StatementRow[] = []
  const apply = (state: SourceState, row: StatementRow) => {
    if (row.reversal) {
      // A refund reversed on a later day stands no more (a sale's reversal names no source).
      if (row.kind === 'refund') state.refunded = subtractDecimals(state.refunded, row.charge)
      return
    }
    if (row.kind === 'order' || row.kind === 'sale') {
      state.base = row.charge
      state.open = true
    } else if (row.kind === 'refund') {
      state.refunded = sumDecimals([state.refunded, row.credit])
    } else if (row.kind === 'invoice') {
      if (state.kind === 'order') state.billed = sumDecimals([state.billed, row.charge])
      else state.invoiced = true
    } else if (row.kind === 'credit_note' && state.kind === 'order' && row.bills_less) {
      state.billed = subtractDecimals(state.billed, row.credit)
    }
  }
  let day: StatementRow[] = []
  const closeDay = () => {
    const bySource = new Map<string, StatementRow[]>()
    for (const row of day) {
      if (row.src_kind === null || row.src_id === null) continue
      const list = bySource.get(row.src_id)
      if (list) list.push(row)
      else bySource.set(row.src_id, [row])
    }
    const dropped = new Set<StatementRow>()
    for (const [id, own] of bySource) {
      let state = sources.get(id)
      if (!state) {
        state = {
          kind: own[0]!.src_kind!,
          base: '0',
          open: false,
          billed: '0',
          refunded: '0',
          invoiced: false,
          own: '0',
        }
        sources.set(id, state)
      }
      const self = own.find((row) => (row.kind === 'order' || row.kind === 'sale') && !row.reversal)
      if (self) {
        // Its own day: it charges what its invoices of the day do not (they charge in full).
        for (const row of own) apply(state, row)
        state.own = ownOf(state)
        self.charge = state.own
        if (compareDecimal(state.own, '0') === 0) dropped.add(self)
        continue
      }
      for (const row of own) {
        const before = state.own
        apply(state, row)
        state.own = ownOf(state)
        const change = subtractDecimals(state.own, before)
        if (row.kind === 'invoice' && compareDecimal(change, '0') < 0) {
          const carried = subtractDecimals('0', change)
          row.charge = subtractDecimals(row.charge, carried)
          row.owedThrough = { amount: carried, orderNumber: row.src_number }
        } else if (row.kind === 'credit_note' && compareDecimal(change, '0') > 0) {
          row.credit = subtractDecimals(row.credit, change)
          row.owedThrough = { amount: change, orderNumber: row.src_number }
        }
      }
    }
    out.push(...day.filter((row) => !dropped.has(row)))
    day = []
  }
  for (const row of rows) {
    if (day.length > 0 && day[0]!.date !== row.date) closeDay()
    day.push({ ...row, owedThrough: null })
  }
  closeDay()
  return out
}
