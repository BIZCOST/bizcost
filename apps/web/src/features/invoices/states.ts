import type { InvoiceDto, InvoiceListItemDto } from '@bizcost/contracts'
import type { CreditNoteKind, InvoiceKind } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'

// What an invoice is called and the state it shows (M3 Step 8; Q26: a plain invoice and credit note
// never say "tax").

/** The title of an invoice's kind: «فاتورة ضريبية · Tax Invoice», or a plain «فاتورة · Invoice». */
export function invoiceKindKey(kind: InvoiceKind): I18nKey {
  return kind === 'tax_invoice'
    ? 'documents.invoices.kinds.taxInvoice'
    : 'documents.invoices.kinds.invoice'
}

/** «إشعار دائن ضريبي · Tax Credit Note», or a plain «إشعار دائن · Credit Note» (never "tax"). */
export function creditNoteKindKey(kind: CreditNoteKind): I18nKey {
  return kind === 'tax_credit_note'
    ? 'documents.invoices.kinds.taxCreditNote'
    : 'documents.invoices.kinds.creditNote'
}

/**
 * What an invoice shows in the list and on its page: a draft; once issued, credited in full, or what
 * its payments say (overdue, owed, part paid, paid), or just issued for a member who doesn't see
 * payments. A partly credited invoice says so beside it.
 */
export type InvoiceState =
  'draft' | 'issued' | 'owed' | 'partPaid' | 'paid' | 'overdue' | 'credited'

export function invoiceStateOf(
  invoice: Pick<InvoiceListItemDto, 'status' | 'creditState' | 'overdue' | 'paymentState'>,
): InvoiceState {
  if (invoice.status === 'draft') return 'draft'
  if (invoice.creditState === 'credited') return 'credited'
  if (invoice.overdue) return 'overdue'
  switch (invoice.paymentState) {
    case 'paid':
    case 'overpaid':
      return 'paid'
    case 'deposit':
      return 'partPaid'
    case 'unpaid':
      return 'owed'
    default:
      return 'issued'
  }
}

/** The list state of a whole invoice (its page reads the same state as its row). */
export function invoiceDtoState(invoice: InvoiceDto): InvoiceState {
  return invoiceStateOf({
    status: invoice.status,
    creditState: invoice.creditState,
    overdue: invoice.overdue,
    paymentState: invoice.payment?.state ?? null,
  })
}
