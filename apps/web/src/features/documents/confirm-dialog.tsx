'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useSayRefusal, type Refusal } from './refusal'

/**
 * "Finalize this purchase?", "Reverse this sale?"…: what will happen, in plain words, then the
 * action or Cancel. Stays open while the action runs and shows its problem if it fails.
 */
export function ConfirmDialog({
  open,
  icon: Icon,
  title,
  body,
  note,
  action,
  busyLabel,
  busy,
  error,
  destructive = false,
  disabled = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  icon: LucideIcon
  title: string
  body: ReactNode
  /** A second paragraph (what stays, what can be done later). */
  note?: ReactNode
  action: string
  busyLabel: string
  busy: boolean
  /** Why the action failed (with the names it is about, when the server sent them). */
  error: Refusal | null
  destructive?: boolean
  /** The action can't be taken now (the error or the note says why). */
  disabled?: boolean
  onConfirm: () => void
  onClose: () => void
  /** A field the action takes, under the words (e.g. why an expense is rejected). */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const say = useSayRefusal()
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      {/* A tall one (a choice it takes, on a small phone) scrolls inside the screen. */}
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto data-[size=default]:max-w-sm data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{body}</p>
              {note ? <p>{note}</p> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error ? <FormAlert tone="error">{say(error)}</FormAlert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
