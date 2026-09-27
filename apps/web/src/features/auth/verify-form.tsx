'use client'

import {
  choosePasswordSchema,
  codeAccepted,
  createCodeVerification,
  isPasswordMessage,
  useFlow,
  type ChoosePasswordForm,
  type CodeVerification,
  type CodeVerificationState,
} from '@bizcost/app-core'
import { AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { zodResolver } from '@hookform/resolvers/zod'
import { InfoIcon, ShieldCheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { PasswordRules } from '@/components/form/password-rules'
import { SLOT, SlotText } from '@/components/form/slot-text'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { takeReturnPath } from '@/features/invite/return-path'
import { CodeCard } from './code-card'
import { forgetPassword, heldPassword } from './held-password'
import { clearPending, savePending, usePending, type PendingCode } from './pending'

/**
 * The code page after sign-up or "send me a code". Without a pending code, back to sign-in. A sign-up
 * code confirms the address, which drops any password chosen before it (D-102): the page then sets
 * the password the sign-up (or sign-in) page was given, or asks for one when it no longer has it.
 */
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
  const { locale } = useLocale()
  // Taken once: a sign-up code sets it again; null (a reload) asks for one. Forgotten on leaving.
  const [password] = useState(() =>
    pending.purpose === 'signUp' ? heldPassword(pending.email) : undefined,
  )
  useEffect(() => forgetPassword, [])
  const [state, flow] = useFlow(
    () =>
      createCodeVerification({
        auth: authClient(),
        email: pending.email,
        purpose: pending.purpose === 'signUp' ? 'signUp' : 'signIn',
        locale,
        sentAt: pending.sentAt,
        retryAt: pending.retryAt,
        password,
      }),
    [pending.email, pending.purpose],
  )
  const busy = state.status !== 'idle'
  const codeError =
    state.error === 'auth.errors.codeInvalid' || state.error === 'auth.validation.codeIncomplete'

  // Keep the countdown and a planned automatic resend (D-073, run once) across a reload of this tab.
  // Once the code is accepted the entry goes (signed in: a reload leaves the auth pages).
  const { resendAvailableAt, retryAt } = state
  const accepted = codeAccepted(state)
  useEffect(() => {
    if (accepted) {
      clearPending()
      return
    }
    savePending({
      ...pending,
      sentAt: resendAvailableAt - AUTH_RESEND_COOLDOWN_SECONDS * 1000,
      retryAt: retryAt ?? undefined,
    })
  }, [pending, accepted, resendAvailableAt, retryAt])

  const verified = state.status === 'verified'
  useEffect(() => {
    if (!verified) return
    forgetPassword()
    // Back to an invitation opened before signing in, else home.
    router.replace(takeReturnPath())
    router.refresh()
  }, [verified, router])

  if (state.status === 'password' || state.status === 'saving') {
    return <ChoosePassword email={pending.email} state={state} flow={flow} />
  }

  const signUp = pending.purpose === 'signUp'

  return (
    <CodeCard
      sentTo={
        <EmailText
          i18nKey={signUp ? 'auth.verify.signUpBody' : 'auth.verify.codeSent'}
          email={pending.email}
        />
      }
      notice={
        pending.notice === 'confirmEmailFirst' ? (
          <FormAlert tone="info" className="mb-5">
            {t('auth.notices.confirmEmailFirst')}
          </FormAlert>
        ) : signUp ? (
          <RegisteredNote />
        ) : null
      }
      codeError={codeError ? message(state.error) : undefined}
      formError={state.error && !codeError ? message(state.error) : undefined}
      checking={state.status === 'verifying' || state.status === 'verified'}
      busy={busy}
      resent={state.notice === 'resent'}
      resendAvailableAt={state.resendAvailableAt}
      onVerify={(code) => void flow.verify(code)}
      onResend={() => void flow.resend()}
      wrongEmailHref={signUp ? '/signup' : '/login'}
      footer={
        signUp ? (
          <Link href="/forgot" className="tap-area font-medium text-primary hover:underline">
            {t('auth.verify.resetPassword')}
          </Link>
        ) : null
      }
    />
  )
}

/**
 * After sign-up: a registered address gets no code and the same screen (D-062), so everyone is told
 * what to do then; shown to every sign-up, it reveals nothing.
 */
function RegisteredNote() {
  const { t } = useTranslation()
  return (
    <p className="mb-5 flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
      <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <SlotText
          text={t('auth.verify.registeredNote', { signIn: SLOT })}
          value={
            <Link href="/login" className="tap-area font-medium text-primary hover:underline">
              {t('auth.verify.registeredSignIn')}
            </Link>
          }
        />
      </span>
    </p>
  )
}

/**
 * After a sign-up code, when this page no longer has the password the sign-up was given (a reload),
 * or the Auth server refused it: the address is confirmed and the user is signed in; they choose the
 * password they will sign in with (D-102).
 */
function ChoosePassword({
  email,
  state,
  flow,
}: {
  email: string
  state: CodeVerificationState
  flow: CodeVerification
}) {
  const { t } = useTranslation()
  const message = useMessage()
  const form = useForm<ChoosePasswordForm>({
    resolver: zodResolver(choosePasswordSchema),
    defaultValues: { password: '' },
  })
  const password = useWatch({ control: form.control, name: 'password' })
  // This step replaced the code form: screen readers start at its heading.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => titleRef.current?.focus(), [])
  const busy = state.status !== 'password'
  const passwordError = state.error && isPasswordMessage(state.error) ? state.error : undefined
  const formError = state.error && !passwordError ? state.error : undefined
  const submit = form.handleSubmit(({ password }) => flow.savePassword(password))

  return (
    <AuthCard title={t('auth.verify.passwordTitle')} titleRef={titleRef}>
      <div className="mb-6 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success [&>svg]:size-5">
          <ShieldCheckIcon aria-hidden />
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('auth.verify.passwordBody')}
        </p>
      </div>
      {formError ? (
        <FormAlert tone="error" className="mb-5">
          {message(formError)}
        </FormAlert>
      ) : null}
      <form method="post" onSubmit={submit} noValidate className="space-y-5">
        {/* Tells password managers which account the password belongs to. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <TextField
          label={t('auth.fields.password')}
          hint={(id) => <PasswordRules id={id} password={password} />}
          error={message(form.formState.errors.password?.message) ?? message(passwordError)}
          render={(a11y) => (
            <PasswordInput autoComplete="new-password" {...a11y} {...form.register('password')} />
          )}
        />
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? t('status.saving') : t('auth.verify.passwordSubmit')}
        </Button>
      </form>
    </AuthCard>
  )
}
