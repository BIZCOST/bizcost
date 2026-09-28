'use client'

import type { DocumentStatus } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

// A document's status next to its name (purchases, supplier returns and credit notes): a draft
// changes nothing yet, a final one counts in the costs, a reversed one no longer does (D-114). In
// Arabic the word agrees with the document: «مشتريات معتمدة», but «مرتجع معتمد» (a return or a credit
// note, `kind="document"`).

const TONES = { draft: 'warning', posted: 'success', reversed: 'neutral' } as const

export function StatusBadge({
  status,
  kind = 'purchase',
}: {
  status: DocumentStatus
  kind?: 'purchase' | 'document'
}) {
  const { t } = useTranslation()
  return (
    <Badge tone={TONES[status]}>
      {kind === 'purchase' ? t(`purchasing.status.${status}`) : t(`purchasing.statusDoc.${status}`)}
    </Badge>
  )
}
