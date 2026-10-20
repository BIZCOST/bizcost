'use client'

import type { InvoiceCreditState } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { InvoiceState } from './data'

// An invoice's state (M3 Step 8): a draft (no number yet); once issued, overdue (owing after its due
// date), owed, part paid, paid, or credited in full by credit notes; "Partly credited" beside it when
// a credit note took back part of it.

const TONES = {
  draft: 'warning',
  issued: 'primary',
  owed: 'primary',
  partPaid: 'primary',
  paid: 'success',
  overdue: 'danger',
  credited: 'neutral',
} as const

export function InvoiceStateBadge({
  state,
  creditState = 'none',
}: {
  state: InvoiceState
  creditState?: InvoiceCreditState
}) {
  const { t } = useTranslation()
  return (
    <>
      <Badge data-invoice-state={state} tone={TONES[state]}>
        {t(`documents.invoices.status.${state}`)}
      </Badge>
      {creditState === 'partly' && state !== 'credited' ? (
        <Badge data-invoice-credit="partly" tone="neutral">
          {t('documents.invoices.status.partlyCredited')}
        </Badge>
      ) : null}
    </>
  )
}
