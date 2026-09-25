'use client'

import { createCodeVerification, useFlow } from '@bizcost/app-core'
import { AUTH_OTP_LENGTH, AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { MailCheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { CodeInput } from '@/components/form/code-input'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { ResendCode } from '@/components/form/resend-code'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { clearPending, savePending, usePending, type PendingCode } from './pending'

/** The code page after sign-up or "send me a code". Without a pending code, back to sign-in. */
export function VerifyForm() {
  const pending = usePending(['signUp', 'signIn'])
  const router = useRouter()
  useEffect(() => {
    if (pending === null) router.replace('/login')
  }, [pending, router])
  return pending ? <VerifyCode pending={pending} /> : null
}

function VerifyCode({ pending }: { pending: PendingCode }) {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const id = useId()
  const { locale } = useLocale()
  const [code, setCode] = useState('')
  const [state, flow] = useFlow(
    () =>
      createCodeVerification({
        auth: authClient(),
        email: pending.email,
        purpose: pending.purpose === 'signUp' ? 'signUp' : 'signIn',
        locale,
        sentAt: pending.sentAt,
      }),
    [pending.email, pending.purpose],
  )
  const busy = state.status !== 'idle'
  const codeError =
    state.error === 'auth.errors.codeInvalid' || state.error === 'auth.validation.codeIncomplete'

  async function verify(value: string) {
    if (await flow.verify(value)) {
      clearPending()
      router.replace('/')
      router.refresh()
    }
  }

  async function resend() {
    await flow.resend()
    const { resendAvailableAt, notice } = flow.getState()
    // Keep the countdown across a reload of this tab.
    if (notice === 'resent')
      savePending({ ...pending, sentAt: resendAvailableAt - AUTH_RESEND_COOLDOWN_SECONDS * 1000 })
  }

  const signUp = pending.purpose === 'signUp'

  return (
    <AuthCard
      title={t('auth.verify.title')}
      footer={
        signUp ? (
          <div className="space-y-2">
            <p>
              {t('auth.verify.alreadyHaveAccount')}{' '}
              <Link href="/login" className="tap-area font-medium text-primary hover:underline">
                {t('auth.verify.signIn')}
              </Link>
            </p>
            <p>
              <Link href="/forgot" className="tap-area font-medium text-primary hover:underline">
                {t('auth.verify.resetPassword')}
              </Link>
            </p>
          </div>
        ) : null
      }
    >
      <div className="mb-6 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
          <MailCheckIcon aria-hidden className="size-5" />
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <EmailText
            i18nKey={signUp ? 'auth.verify.signUpBody' : 'auth.verify.codeSent'}
            email={pending.email}
          />
        </p>
      </div>
      {pending.notice === 'confirmEmailFirst' ? (
        <FormAlert tone="info" className="mb-5">
          {t('auth.notices.confirmEmailFirst')}
        </FormAlert>
      ) : null}
      {state.notice === 'resent' ? (
        <FormAlert tone="success" className="mb-5">
          {t('auth.verify.resent')}
        </FormAlert>
      ) : null}
      {state.error && !codeError ? (
        <FormAlert tone="error" className="mb-5">
          {message(state.error)}
        </FormAlert>
      ) : null}
      <form
        method="post"
        noValidate
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void verify(code)
        }}
      >
        <Field data-invalid={codeError || undefined}>
          <FieldLabel htmlFor={id}>{t('auth.verify.codeInputLabel')}</FieldLabel>
          <CodeInput
            id={id}
            value={code}
            onChange={setCode}
            onComplete={(value) => void verify(value)}
            disabled={busy}
            autoFocus
            aria-invalid={codeError}
            aria-describedby={`${id}-hint`}
          />
          {codeError ? (
            <FieldError id={`${id}-hint`}>{message(state.error)}</FieldError>
          ) : (
            <FieldDescription id={`${id}-hint`}>
              {t('auth.verify.codeHint', { count: AUTH_OTP_LENGTH })}
            </FieldDescription>
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {state.status === 'verifying' || state.status === 'verified'
            ? t('status.checking')
            : t('auth.verify.submit')}
        </Button>
      </form>
      <div className="mt-6 space-y-1 border-t pt-5">
        <p className="text-sm text-muted-foreground">{t('auth.verify.noCode')}</p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ResendCode
            availableAt={state.resendAvailableAt}
            busy={busy}
            onResend={() => void resend()}
          />
          <Link
            href={signUp ? '/signup' : '/login'}
            className="tap-area text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('auth.verify.wrongEmail')}
          </Link>
        </div>
      </div>
    </AuthCard>
  )
}
