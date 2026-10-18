'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { QuotationDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, Loader2Icon, Share2Icon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { canShareFile, downloadFile, pdfFileOf, shareFile } from './pdf-file'

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
  const pdf = useMutation(trpc.quotation.pdf.mutationOptions())
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const { mutateAsync } = pdf

  // Made once each time the dialog opens (the revision may have changed in between).
  useEffect(() => {
    if (!open) return
    let gone = false
    setFile(null)
    setError(null)
    mutateAsync({ id: quotation.id })
      .then((made) => {
        if (!gone) setFile(pdfFileOf(made))
      })
      .catch((caught: unknown) => {
        if (!gone) setError(apiErrorKey(caught))
      })
    return () => {
      gone = true
    }
  }, [open, quotation.id, quotation.version, mutateAsync])

  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )
  const sharable = file !== null && canShareFile(file)
  const title = t('documents.quotations.view.title', { number: isolate(quotation.number) })

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{heading ?? t('documents.quotations.pdf.title')}</DialogTitle>
          <DialogDescription>
            {quotation.status === 'draft'
              ? t('documents.quotations.pdf.draftNote')
              : t('documents.quotations.pdf.sendNote')}
          </DialogDescription>
        </DialogHeader>
        {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
        {!file && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            {t('documents.quotations.pdf.making')}
          </p>
        ) : null}
        {file && url ? (
          <>
            {/* The browser's own PDF viewer, where it has one (desktops); phones open it instead. */}
            <iframe
              title={title}
              src={url}
              data-pdf-preview
              className="hidden h-[60vh] w-full rounded-xl border bg-muted md:block"
            />
            <div className="flex items-center gap-3 rounded-xl border bg-background/60 p-3 md:hidden">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
                <FileTextIcon aria-hidden className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span dir="ltr" className="block truncate text-sm font-medium">
                  {file.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('documents.quotations.pdf.ready')}
                </span>
              </span>
            </div>
          </>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {sharable ? (
            <Button
              type="button"
              data-pdf-share
              disabled={!file}
              onClick={() => {
                if (!file) return
                shareFile(file, title).catch(() =>
                  toast.error(t('documents.quotations.pdf.shareFailed')),
                )
              }}
            >
              <Share2Icon aria-hidden />
              {t('documents.quotations.pdf.share')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={sharable ? 'outline' : 'default'}
            data-pdf-download
            disabled={!file}
            onClick={() => file && downloadFile(file)}
          >
            <DownloadIcon aria-hidden />
            {t('documents.quotations.pdf.download')}
          </Button>
          {url ? (
            <Button asChild variant="ghost" className="md:hidden">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon aria-hidden />
                {t('documents.quotations.pdf.open')}
              </a>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
