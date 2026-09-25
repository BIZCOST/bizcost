'use client'

import {
  createPasswordReset,
  resetPasswordSchema,
  useFlow,
  type PasswordReset,
  type PasswordResetState,
  type ResetPasswordForm,
  type ResetStep,
} from '@bizcost/app-core'
import { AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeftIcon, CircleCheckIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AuthCard } from '@/components/auth/auth-shell'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { PasswordRules } from '@/components/form/password-rules'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/supabase/browser'
import { cn } from '@/lib/utils'
import { CodeCard } from './code-card'
import { clearPending, savePending, usePending, type PendingCode } from './pending'

// After "Forgot password" (D-071): the code only. Once Supabase accepts it (the user is signed in),
// the user chooses a new password or goes straight in; a code that confirmed the address requires a
// new password. Without a pending code, back to the email step. Opened again after the code (a
// reload, Back): still signed in → continue; otherwise (or when a password was required) this
// device is signed out and the user asks for a new code or signs in.

export function ResetForm() {
  const pending = usePending(['recovery'])
  const router = useRouter()
  useEffect(() => {
    if (pending === null) router.replace('/forgot')
  }, [pending, router])
  return pending ? <ResetSteps pending={pending} /> : null
}

function ResetSteps({ pending }: { pending: PendingCode }) {
  const { t } = useTranslation()
  const router = useRouter()
  const [state, flow] = useFlow(
    () =>
      createPasswordReset({
        auth: authClient(),
        email: pending.email,
        sentAt: pending.sentAt,
        retryAt: pending.retryAt,
        codeUsed: pending.verified,
        passwordRequired: pending.passwordRequired,
      }),
    [pending.email],
  )
  const { step, passwordChanged } = state

  useEffect(() => {
    if (step === 'resuming') void flow.resume()
  }, [step, flow])

  // Keep this tab's entry in step: once the code is used a reload offers no password change, a new
  // code keeps its countdown, a planned automatic resend (D-073) runs once, and a required password
  // stays required.
  const { email, passwordRequired, resendAvailableAt, retryAt } = state
  const done = step === 'done'
  const codeUsed = step !== 'code'
  useEffect(() => {
    if (done) return
    const entry: PendingCode = {
      email,
      purpose: 'recovery',
      sentAt: resendAvailableAt - AUTH_RESEND_COOLDOWN_SECONDS * 1000,
    }
    if (retryAt !== null) entry.retryAt = retryAt
    if (codeUsed) entry.verified = true
    if (passwordRequired) entry.passwordRequired = true
    savePending(entry)
  }, [done, email, codeUsed, passwordRequired, resendAvailableAt, retryAt])

  useEffect(() => {
    if (!done) return
    clearPending()
    if (passwordChanged) toast.success(t('auth.reset.done'))
    router.replace('/')
    router.refresh()
  }, [done, passwordChanged, router, t])

  // On 'done' the last step stays on screen, disabled, until home opens.
  const [shown, setShown] = useState<Exclude<ResetStep, 'done'>>(done ? 'code' : step)
  if (step !== 'done' && step !== shown) setShown(step)
  const busy = state.status !== 'idle' || done

  switch (shown) {
    case 'code':
      return <ResetCode email={pending.email} state={state} flow={flow} />
    case 'choose':
      return <ResetChoice flow={flow} busy={busy} />
    case 'password':
      return <NewPassword email={pending.email} state={state} flow={flow} busy={busy} />
    case 'resuming':
      return null
    case 'signedIn':
      return <StillSignedIn flow={flow} busy={busy} />
    case 'ended':
      return <ResetEnded flow={flow} busy={busy} />
  }
}

/** Focus moves to the heading of a step that replaced another, so screen readers start there. */
function useFocusedTitle() {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return ref
}

function BackToSignIn() {
  const { t } = useTranslation()
  return (
    <Link
      href="/login"
      className="-my-3 inline-flex min-h-11 items-center gap-1.5 py-3 font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('auth.forgot.backToSignIn')}
    </Link>
  )
}

function ResetCode({
  email,
  state,
  flow,
}: {
  email: string
  state: PasswordResetState
  flow: PasswordReset
}) {
  const message = useMessage()
  return (
    <CodeCard
      sentTo={<EmailText i18nKey="auth.verify.codeSentIfAccount" email={email} />}
      codeError={state.error?.field === 'code' ? message(state.error.key) : undefined}
      formError={state.error && !state.error.field ? message(state.error.key) : undefined}
      checking={state.status === 'verifying'}
      busy={state.status !== 'idle'}
      resent={state.notice === 'resent'}
      resendAvailableAt={state.resendAvailableAt}
      onVerify={(code) => void flow.verify(code)}
      onResend={() => void flow.resend()}
      wrongEmailHref="/forgot"
      footer={<BackToSignIn />}
    />
  )
}

/** A round icon next to the first line of a card, as on the code screen. */
function Lead({
  icon,
  tone,
  children,
}: {
  icon: ReactNode
  tone: 'success' | 'muted'
  children: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full [&>svg]:size-5',
          tone === 'success' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

function ResetChoice({ flow, busy }: { flow: PasswordReset; busy: boolean }) {
  const { t } = useTranslation()
  const titleRef = useFocusedTitle()
  return (
    <AuthCard title={t('auth.reset.confirmedTitle')} titleRef={titleRef}>
      <Lead icon={<CircleCheckIcon aria-hidden />} tone="success">
        {t('auth.reset.signedIn')}
      </Lead>
      <p className="mb-4 font-medium">{t('auth.reset.changeQuestion')}</p>
      <div className="space-y-3">
        <Button size="lg" className="w-full" onClick={flow.choosePassword} disabled={busy}>
          <KeyRoundIcon aria-hidden />
          {t('auth.reset.changePassword')}
        </Button>
        <Button size="lg" variant="outline" className="w-full" onClick={flow.skip} disabled={busy}>
          {t('auth.reset.keepPassword')}
        </Button>
      </div>
    </AuthCard>
  )
}

function NewPassword({
  email,
  state,
  flow,
  busy,
}: {
  email: string
  state: PasswordResetState
  flow: PasswordReset
  busy: boolean
}) {
  const { t } = useTranslation()
  const message = useMessage()
  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })
  const password = useWatch({ control: form.control, name: 'password' })
  const titleRef = useFocusedTitle()
  const required = state.passwordRequired
  const errors = form.formState.errors
  const passwordError = state.error?.field === 'password' ? message(state.error.key) : undefined
  const submit = form.handleSubmit(({ password }) => flow.savePassword(password))

  return (
    // Chosen: straight to the new password. Required: the heading first, so the reason is heard.
    <AuthCard title={t('auth.reset.title')} titleRef={required ? titleRef : undefined}>
      {required ? (
        <Lead icon={<ShieldCheckIcon aria-hidden />} tone="success">
          {t('auth.reset.requiredBody')}
        </Lead>
      ) : null}
      {state.error && !state.error.field ? (
        <FormAlert tone="error" className="mb-5">
          {message(state.error.key)}
        </FormAlert>
      ) : null}
      <form method="post" onSubmit={submit} noValidate className="space-y-5">
        {/* Tells password managers which account the new password belongs to. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <TextField
          label={t('auth.fields.newPassword')}
          hint={(id) => <PasswordRules id={id} password={password} />}
          error={message(errors.password?.message) ?? passwordError}
          render={(a11y) => (
            <PasswordInput
              autoComplete="new-password"
              autoFocus={!required}
              {...a11y}
              {...form.register('password')}
            />
          )}
        />
        <TextField
          label={t('auth.fields.confirmPassword')}
          error={message(errors.confirmPassword?.message)}
          render={(a11y) => (
            <PasswordInput
              autoComplete="new-password"
              {...a11y}
              {...form.register('confirmPassword')}
            />
          )}
        />
        <div className="space-y-3">
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? t('status.saving') : t('auth.reset.submit')}
          </Button>
          {required ? null : (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full"
              onClick={flow.back}
              disabled={busy}
            >
              {t('actions.back')}
            </Button>
          )}
        </div>
      </form>
    </AuthCard>
  )
}

/** Opened again after the code while still signed in: continue (no password change here). */
function StillSignedIn({ flow, busy }: { flow: PasswordReset; busy: boolean }) {
  const { t } = useTranslation()
  const titleRef = useFocusedTitle()
  return (
    <AuthCard title={t('auth.reset.resumedTitle')} titleRef={titleRef}>
      <Lead icon={<CircleCheckIcon aria-hidden />} tone="success">
        {t('auth.reset.resumedBody')}
      </Lead>
      <Button size="lg" className="w-full" onClick={flow.skip} disabled={busy}>
        {t('auth.reset.continue')}
      </Button>
    </AuthCard>
  )
}

/** This device was signed out and the password was not changed: a new code, or sign in. */
function ResetEnded({ flow, busy }: { flow: PasswordReset; busy: boolean }) {
  const { t } = useTranslation()
  const router = useRouter()
  const titleRef = useFocusedTitle()
  return (
    <AuthCard title={t('auth.reset.endedTitle')} titleRef={titleRef}>
      <Lead icon={<ShieldCheckIcon aria-hidden />} tone="muted">
        {t('auth.reset.endedBody')}
      </Lead>
      <div className="space-y-3">
        <Button size="lg" className="w-full" onClick={() => void flow.restart()} disabled={busy}>
          {t('auth.verify.resend')}
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={() => router.replace('/login')}
          disabled={busy}
        >
          {t('auth.verify.signIn')}
        </Button>
      </div>
    </AuthCard>
  )
}
