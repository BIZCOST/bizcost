'use client'

import { useTRPC } from '@bizcost/app-core'
import type { QuotationDto } from '@bizcost/contracts'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { PdfDialog } from './pdf-dialog'

// A quotation's PDF on the business's letterhead (M3 Step 7; Q23): made when asked for (counted
// against the PDF limit), shown in the browser's own viewer on a desktop, and sent by download or the
// phone's share sheet (WhatsApp, mail apps). A draft's PDF is marked as a draft.

export function QuotationPdfDialog({
  quotation,
  open,
  heading,
  onClose,
}: {
  quotation: QuotationDto
  open: boolean
  /** "Sent: share the PDF", or the preview's own title. */
  heading?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { mutateAsync } = useMutation(trpc.quotation.pdf.mutationOptions())
  return (
    <PdfDialog
      open={open}
      title={heading ?? t('documents.quotations.pdf.title')}
      description={
        quotation.status === 'draft'
          ? t('documents.quotations.pdf.draftNote')
          : t('documents.quotations.pdf.sendNote')
      }
      shareTitle={t('documents.quotations.view.title', { number: isolate(quotation.number) })}
      remake={`${quotation.id}:${quotation.version}`}
      make={() => mutateAsync({ id: quotation.id })}
      onClose={onClose}
    />
  )
}
