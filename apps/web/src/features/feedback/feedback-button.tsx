'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  FEEDBACK_IMAGE_TYPES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  type FeedbackImageType,
} from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { ImagePlusIcon, MessageSquarePlusIcon, XIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { pagePathOf, pictureFits } from './feedback-rules'

// "Send feedback" (Q4, D-356) on every signed-in page, from the top bar of the plain shell and of the
// business shell, on phones and on desktops. What it sends: the message, this page's path (never what
// follows it) and an optional picture; the server adds who and, inside a business, which business. A
// picture goes straight to the private bucket, then the API checks it as it checks a line's picture.

function FeedbackForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const uploadUrl = useMutation(trpc.feedback.imageUploadUrl.mutationOptions())
  const send = useMutation(trpc.feedback.send.mutationOptions())
  const ids = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState('')
  const [picture, setPicture] = useState<File | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const [sending, setSending] = useState(false)

  async function upload(file: File): Promise<string> {
    const target = await uploadUrl.mutateAsync({ contentType: file.type as FeedbackImageType })
    const response = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type, 'x-upsert': 'false' },
      body: file,
    })
    if (!response.ok) throw new PictureRefused()
    return target.path
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (sending) return
    setError(null)
    if (message.trim() === '') {
      setFieldError(t('feedback.required'))
      return
    }
    setFieldError(null)
    setSending(true)
    try {
      const imagePath = picture ? await upload(picture) : undefined
      await send.mutateAsync({
        message,
        pagePath: pagePathOf(window.location.pathname),
        ...(imagePath ? { imagePath } : {}),
      })
      toast.success(t('feedback.sent'))
      onDone()
    } catch (caught) {
      if (caught instanceof PictureRefused) {
        setError('common.feedback.pictureInvalid')
      } else if (caught instanceof TypeError) {
        setError('errors.network')
      } else {
        const key = apiErrorKey(caught)
        setError(key === 'errors.attachment_invalid' ? 'common.feedback.pictureInvalid' : key)
      }
      setSending(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${ids}-message`}>{t('feedback.message')}</FieldLabel>
        <Textarea
          id={`${ids}-message`}
          // Empty, it follows the page: `auto` would put an Arabic placeholder and the caret on the left.
          dir={message ? 'auto' : undefined}
          rows={5}
          autoFocus
          maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
          placeholder={t('feedback.placeholder')}
          value={message}
          aria-invalid={Boolean(fieldError)}
          aria-describedby={fieldError ? `${ids}-message-error` : undefined}
          onChange={(event) => {
            setMessage(event.target.value)
            setFieldError(null)
          }}
        />
        {fieldError ? <FieldError id={`${ids}-message-error`}>{fieldError}</FieldError> : null}
      </div>
      <div>
        <input
          ref={fileInput}
          type="file"
          accept={FEEDBACK_IMAGE_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-feedback-picture-input
          onChange={(event) => {
            const picked = event.target.files?.[0]
            event.target.value = ''
            if (!picked) return
            if (pictureFits(picked)) {
              setPicture(picked)
              setError(null)
            } else {
              setError('common.feedback.pictureInvalid')
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            <ImagePlusIcon aria-hidden />
            {picture ? t('feedback.pictureChange') : t('feedback.picture')}
          </Button>
          {picture ? (
            // One group: on a narrow screen the X moves with its file's name, never alone.
            <div className="flex min-w-0 items-center gap-2">
              <span dir="auto" className="max-w-40 truncate text-sm text-muted-foreground">
                {picture.name}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('feedback.pictureRemove')}
                onClick={() => setPicture(null)}
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('feedback.about')}</p>
      <DialogFooter>
        <Button type="submit" size="lg" disabled={sending}>
          {sending ? t('feedback.sending') : t('feedback.send')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Storage refused the picture (its size or type). */
class PictureRefused extends Error {}

/** The top bar's button: the icon on phones, with its words from the tablet up. */
export function FeedbackButton() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        className="min-w-11 gap-2 px-2 text-muted-foreground hover:text-foreground sm:px-3"
        aria-label={t('nav.feedback')}
        data-feedback-button
        onClick={() => setOpen(true)}
      >
        <MessageSquarePlusIcon aria-hidden className="size-4" />
        <span className="hidden md:inline">{t('nav.feedback')}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t('actions.close')}>
          <DialogHeader>
            <DialogTitle>{t('feedback.title')}</DialogTitle>
            <DialogDescription>{t('feedback.hint')}</DialogDescription>
          </DialogHeader>
          {/* A new form each time: what was sent never comes back. */}
          {open ? <FeedbackForm onDone={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
