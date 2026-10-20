'use client'

import { apiErrorKey } from '@bizcost/app-core'
import type { DocumentPdfDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, Loader2Icon, Share2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { canShareFile, downloadFile, pdfFileOf, shareFile } from './pdf-file'

// A document's PDF on the business's letterhead (quotations, M3 Step 7; invoices, credit notes and
// statements, M3 Step 8; Q23): made or fetched when the dialog opens (counted against the PDF limit),
// shown in the browser's own viewer on a desktop, and sent by download or the phone's share sheet
// (WhatsApp, mail apps).

export function PdfDialog({
  open,
  title,
  description,
  shareTitle,
  remake,
  make,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  /** The shared file's title (and the preview frame's): "Tax Invoice INV-0001". */
  shareTitle: string
  /** Changes when the document changed (its id and version): the PDF is made again. */
  remake: string
  make: () => Promise<DocumentPdfDto>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const maker = useRef(make)
  useEffect(() => {
    maker.current = make
  })

  // Made once each time the dialog opens (the document may have changed in between).
  useEffect(() => {
    if (!open) return
    let gone = false
    setFile(null)
    setError(null)
    maker
      .current()
      .then((made) => {
        if (!gone) setFile(pdfFileOf(made))
      })
      .catch((caught: unknown) => {
        if (!gone) setError(apiErrorKey(caught))
      })
    return () => {
      gone = true
    }
  }, [open, remake])

  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )
  const sharable = file !== null && canShareFile(file)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
        {!file && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            {t('documents.pdfFile.making')}
          </p>
        ) : null}
        {file && url ? (
          <>
            {/* The browser's own PDF viewer, where it has one (desktops); phones open it instead. */}
            <iframe
              title={shareTitle}
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
                  {t('documents.pdfFile.ready')}
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
                shareFile(file, shareTitle).catch(() =>
                  toast.error(t('documents.pdfFile.shareFailed')),
                )
              }}
            >
              <Share2Icon aria-hidden />
              {t('documents.pdfFile.share')}
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
            {t('documents.pdfFile.download')}
          </Button>
          {url ? (
            <Button asChild variant="ghost" className="md:hidden">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon aria-hidden />
                {t('documents.pdfFile.open')}
              </a>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
