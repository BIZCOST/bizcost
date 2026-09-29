'use client'

import type { ExpenseStatus } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

// An expense's status next to its name (M2 Step 5; D-164): a draft counts nothing yet, one sent for
// approval waits for someone who approves expenses, an approved one waits to be finalized, a rejected
// one goes back to be changed, a final one counts in the expenses, a reversed one no longer does.

const TONES = {
  draft: 'warning',
  submitted: 'primary',
  approved: 'primary',
  rejected: 'danger',
  posted: 'success',
  reversed: 'neutral',
} as const satisfies Record<ExpenseStatus, string>

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  const { t } = useTranslation()
  return (
    <Badge tone={TONES[status]} data-status={status}>
      {t(`expenses.status.${status}`)}
    </Badge>
  )
}
