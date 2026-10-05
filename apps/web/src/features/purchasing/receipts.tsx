'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_RECORD_MAX,
  type AttachmentContentType,
  type AttachmentDto,
} from '@bizcost/contracts'
import type { AttachmentEntity } from '@bizcost/domain'
import { formatNumber, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  PaperclipIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Locked } from '@/features/documents/amounts'
import { useLocale } from '@/lib/i18n/client'

// A purchase's receipts (M2 Step 3; D-139), and an expense's (M2 Step 5): photos (PNG, JPEG, WebP) or
// PDFs of up to 10 MB, uploaded straight to the private bucket with a signed URL the API issues
// (attachment.uploadUrl), then checked and attached by the API (attachment.add). Each opens through a
// signed link of a few minutes. A receipt shows what was paid, so a member who may not see supplier
// prices sees its name only.

function isAttachmentType(type: string): type is AttachmentContentType {
  return (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(type)
}

/** The accept list of the file picker: the types the bucket takes. */
export const RECEIPT_ACCEPT = ATTACHMENT_CONTENT_TYPES.join(',')

/** A file the picker gave, checked before anything is sent: the message key of its problem. */
export function receiptProblem(file: File): I18nKey | null {
  if (!isAttachmentType(file.type) || file.size > ATTACHMENT_MAX_BYTES) {
    return 'errors.attachment_invalid'
  }
  return null
}

/**
 * Uploads one file and attaches it to the purchase or expense `recordId` (`entity`); throws with the
 * problem's key.
 */
export function useUploadReceipt(entity: AttachmentEntity = 'purchase') {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const uploadUrl = useMutation(trpc.attachment.uploadUrl.mutationOptions())
  const add = useMutation(trpc.attachment.add.mutationOptions())
  return async (recordId: string, file: File): Promise<void> => {
    const problem = receiptProblem(file)
    if (problem) throw new ReceiptError(problem)
    const record = { entity, entityId: recordId }
    try {
      const target = await uploadUrl.mutateAsync({
        ...record,
        contentType: file.type as AttachmentContentType,
      })
      const response = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type, 'x-upsert': 'false' },
        body: file,
      })
      if (!response.ok) {
        throw new ReceiptError(
          response.status === 413 || response.status === 400 || response.status === 415
            ? 'errors.attachment_invalid'
            : 'errors.internal',
        )
      }
      await add.mutateAsync({ ...record, path: target.path, fileName: file.name.slice(0, 200) })
    } catch (caught) {
      if (caught instanceof ReceiptError) throw caught
      throw new ReceiptError(caught instanceof TypeError ? 'errors.network' : apiErrorKey(caught))
    } finally {
      await queryClient.invalidateQueries({ queryKey: trpc.attachment.list.pathKey() })
      await queryClient.invalidateQueries({ queryKey: recordKey(trpc, entity, recordId) })
    }
  }
}

/** The query of the record the receipts belong to (it counts them). */
function recordKey(trpc: ReturnType<typeof useTRPC>, entity: AttachmentEntity, id: string) {
  return entity === 'expense'
    ? trpc.expense.get.queryKey({ id })
    : trpc.purchase.get.queryKey({ id })
}

export class ReceiptError extends Error {
  constructor(readonly key: I18nKey) {
    super(key)
  }
}

/** "1.2 MB", "340 KB". */
function useFileSize() {
  const { locale } = useLocale()
  const { t } = useTranslation()
  return (bytes: number) => {
    const megabytes = bytes / (1024 * 1024)
    return megabytes >= 1
      ? t('purchasing.receipts.megabytes', {
          size: formatNumber(locale, megabytes, { maximumFractionDigits: 1 }),
        })
      : t('purchasing.receipts.kilobytes', {
          size: formatNumber(locale, Math.max(1, Math.round(bytes / 1024))),
        })
  }
}

function FileIcon({ type }: { type: string }) {
  const Icon = type === 'application/pdf' ? FileTextIcon : ImageIcon
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-4" />
    </span>
  )
}

/** The attach button and its hidden file picker (phones offer the camera). */
function AttachButton({
  busy,
  disabled,
  onFile,
}: {
  busy: boolean
  disabled?: boolean
  onFile: (file: File) => void
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  return (
    <>
      <input
        ref={input}
        id={id}
        type="file"
        accept={RECEIPT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-receipt-input
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <Loader2Icon aria-hidden className="animate-spin" />
        ) : (
          <PaperclipIcon aria-hidden />
        )}
        {busy ? t('purchasing.receipts.attaching') : t('purchasing.receipts.attach')}
      </Button>
    </>
  )
}

/** Receipts picked for a purchase or expense that is not saved yet: attached once it is. */
export function PendingReceipts({
  files,
  onChange,
}: {
  files: readonly File[]
  onChange: (files: File[]) => void
}) {
  const { t } = useTranslation()
  const size = useFileSize()
  const [error, setError] = useState<I18nKey | null>(null)
  return (
    <div className="space-y-3">
      {files.length > 0 ? (
        <ul className="space-y-2">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex items-center gap-3 rounded-xl border bg-background/60 p-2 ps-3"
            >
              <FileIcon type={file.type} />
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-sm font-medium">
                  {file.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {size(file.size)} · {t('purchasing.receipts.pending')}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('purchasing.receipts.remove', { name: isolate(file.name) })}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
      {files.length < ATTACHMENTS_PER_RECORD_MAX ? (
        <AttachButton
          busy={false}
          onFile={(file) => {
            const problem = receiptProblem(file)
            setError(problem)
            if (!problem) onChange([...files, file])
          }}
        />
      ) : null}
    </div>
  )
}

/** A saved purchase's or expense's receipts: open, attach and remove (removing asks first). */
export function Receipts({
  entity = 'purchase',
  recordId,
  canManage,
}: {
  entity?: AttachmentEntity
  recordId: string
  canManage: boolean
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const size = useFileSize()
  const upload = useUploadReceipt(entity)
  const list = useQuery(trpc.attachment.list.queryOptions({ entity, entityId: recordId }))
  const remove = useMutation(trpc.attachment.remove.mutationOptions())
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const [removing, setRemoving] = useState<AttachmentDto | null>(null)
  const items = list.data?.data.items ?? []

  async function attach(file: File) {
    setError(null)
    setUploading(true)
    try {
      await upload(recordId, file)
      toast.success(t('purchasing.receipts.attached'))
    } catch (caught) {
      setError(caught instanceof ReceiptError ? caught.key : 'errors.internal')
    } finally {
      setUploading(false)
    }
  }

  async function confirmRemove() {
    if (!removing) return
    try {
      await remove.mutateAsync({ id: removing.id })
      toast.success(t('purchasing.receipts.removed'))
      setRemoving(null)
    } catch (caught) {
      setError(apiErrorKey(caught))
      setRemoving(null)
    } finally {
      await queryClient.invalidateQueries({ queryKey: trpc.attachment.list.pathKey() })
      await queryClient.invalidateQueries({ queryKey: recordKey(trpc, entity, recordId) })
    }
  }

  return (
    <div className="space-y-3">
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('purchasing.receipts.none')}</p>
      ) : (
        <ul aria-label={t('purchasing.receipts.title')} className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-xl border bg-background/60 p-2 ps-3"
            >
              <FileIcon type={item.contentType} />
              <span className="min-w-0 flex-1">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    dir="auto"
                    className="block truncate text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {item.fileName}
                  </a>
                ) : (
                  <span dir="auto" className="block truncate text-sm font-medium">
                    {item.fileName}
                  </span>
                )}
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {size(item.sizeBytes)}
                  {item.url === undefined ? <Locked category="supplier_price" /> : null}
                </span>
              </span>
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('purchasing.receipts.remove', { name: isolate(item.fileName) })}
                  onClick={() => setRemoving(item)}
                  className="text-muted-foreground"
                >
                  <Trash2Icon aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
      {canManage && items.length < ATTACHMENTS_PER_RECORD_MAX ? (
        <AttachButton busy={uploading} onFile={(file) => void attach(file)} />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !remove.isPending && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('purchasing.receipts.removeTitle', { name: isolate(removing?.fileName ?? '') })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {entity === 'expense'
                ? t('purchasing.receipts.removeBodyExpense')
                : t('purchasing.receipts.removeBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => void confirmRemove()}
            >
              {remove.isPending ? t('status.removing') : t('purchasing.receipts.removeAction')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
