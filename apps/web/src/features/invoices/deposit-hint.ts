import type { I18nKey } from '@bizcost/i18n'

// The line under "It's a deposit" in the bill dialog. A business not registered for VAT sees no VAT
// anywhere (PRODUCT.md §4 rule 12), as `maySeeDeposits` keeps its tax-deposit list from it, so it has its
// own wording.

/** The hint of the deposit checkbox, by the business's VAT registration. */
export function depositHintKey(vatRegistered: boolean): I18nKey {
  return vatRegistered
    ? 'documents.invoices.bill.depositHint'
    : 'documents.invoices.bill.depositHintPlain'
}
