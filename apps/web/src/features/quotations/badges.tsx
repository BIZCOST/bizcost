'use client'

import type { QuotationListStatus } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

// A quotation's status (M3 Step 7): Draft → Sent → Accepted or Declined; a sent one past its validity
// shows as Expired (it can still be accepted); an older revision once a newer one is sent, Replaced.

const TONES = {
  draft: 'warning',
  sent: 'primary',
  expired: 'danger',
  accepted: 'success',
  declined: 'neutral',
  superseded: 'neutral',
} as const

export function QuotationStatusBadge({ status }: { status: QuotationListStatus }) {
  const { t } = useTranslation()
  return (
    <Badge data-quotation-status={status} tone={TONES[status]}>
      {t(`documents.quotations.status.${status}`)}
    </Badge>
  )
}
