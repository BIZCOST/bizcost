'use client'

import type { DocumentStatus } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

// A document's status next to its name (purchases, supplier returns and credit notes, sales): a draft
// changes nothing yet, a final one counts, a reversed one no longer does (D-114, D-227). In Arabic the
// word agrees with the document: «مشتريات معتمدة», but «مرتجع معتمد» (a return or a credit note,
// `kind="document"`); a sale says its own words (`kind="sale"`, the sales messages).

const TONES = { draft: 'warning', posted: 'success', reversed: 'neutral' } as const

export function StatusBadge({
  status,
  kind = 'purchase',
}: {
  status: DocumentStatus
  kind?: 'purchase' | 'document' | 'sale'
}) {
  const { t } = useTranslation()
  return (
    <Badge tone={TONES[status]}>
      {kind === 'sale'
        ? t(`sales.status.${status}`)
        : kind === 'purchase'
          ? t(`purchasing.status.${status}`)
          : t(`purchasing.statusDoc.${status}`)}
    </Badge>
  )
}
