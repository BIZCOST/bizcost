'use client'

import { AUTH_OTP_LENGTH } from '@bizcost/contracts'
import { MailCheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { CodeInput } from '@/components/form/code-input'
import { FormAlert } from '@/components/form/form-alert'
import { ResendCode } from '@/components/form/resend-code'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'

/**
 * The card of a code page (/verify, /reset): where the code went, the code cells (checked as soon as
 * they are full), "Send a new code" after the cooldown and "Use a different email". After a failed
 * check, focus returns to the cells (disabled while checking), and a wrong code is cleared.
 */
export function CodeCard({
  sentTo,
  notice,
  codeError,
  formError,
  checking,
  busy,
  resent,
  resendAvailableAt,
  onVerify,
  onResend,
  wrongEmailHref,
  footer,
}: {
  /** The "we sent a code to …" sentence. */
  sentTo: ReactNode
  /** A message above the form. */
  notice?: ReactNode
  /** Translated message under the code (wrong or incomplete). */
  codeError?: string
  /** Translated message for the whole form. */
  formError?: string
  checking: boolean
  busy: boolean
  resent: boolean
  /** Epoch ms when a new code may be requested. */
  resendAvailableAt: number
  onVerify: (code: string) => void
  onResend: () => void
  wrongEmailHref: string
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId()
  const [code, setCode] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [wasChecking, setWasChecking] = useState(checking)
  const [refocus, setRefocus] = useState(0)
  if (wasChecking !== checking) {
    setWasChecking(checking)
    // A check ended without leaving the page: it failed.
    if (!checking) {
      if (codeError) setCode('')
      setRefocus((n) => n + 1)
    }
  }
  useEffect(() => {
    if (refocus > 0) inputRef.current?.focus()
  }, [refocus])

  return (
    <AuthCard title={t('auth.verify.title')} footer={footer}>
      <div className="mb-6 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
          <MailCheckIcon aria-hidden className="size-5" />
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">{sentTo}</p>
      </div>
      {notice}
      {resent ? (
        <FormAlert tone="success" className="mb-5">
          {t('auth.verify.resent')}
        </FormAlert>
      ) : null}
      {formError ? (
        <FormAlert tone="error" className="mb-5">
          {formError}
        </FormAlert>
      ) : null}
      <form
        method="post"
        noValidate
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          onVerify(code)
        }}
      >
        <Field data-invalid={Boolean(codeError) || undefined}>
          <FieldLabel htmlFor={id}>{t('auth.verify.codeInputLabel')}</FieldLabel>
          <CodeInput
            ref={inputRef}
            id={id}
            value={code}
            onChange={setCode}
            onComplete={onVerify}
            disabled={busy}
            autoFocus
            aria-invalid={Boolean(codeError)}
            aria-describedby={`${id}-hint`}
          />
          {codeError ? (
            <FieldError id={`${id}-hint`}>{codeError}</FieldError>
          ) : (
            <FieldDescription id={`${id}-hint`}>
              {t('auth.verify.codeHint', { count: AUTH_OTP_LENGTH })}
            </FieldDescription>
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {checking ? t('status.checking') : t('auth.verify.submit')}
        </Button>
      </form>
      <div className="mt-6 space-y-1 border-t pt-5">
        <p className="text-sm text-muted-foreground">{t('auth.verify.noCode')}</p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ResendCode availableAt={resendAvailableAt} busy={busy} onResend={onResend} />
          <Link
            href={wrongEmailHref}
            className="tap-area text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('auth.verify.wrongEmail')}
          </Link>
        </div>
      </div>
    </AuthCard>
  )
}
