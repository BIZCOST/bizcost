'use client'

import {
  createPasswordReset,
  resetPasswordSchema,
  useFlow,
  type ResetPasswordForm,
} from '@bizcost/app-core'
import { AUTH_PASSWORD_MIN_LENGTH, AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AuthCard } from '@/components/auth/auth-shell'
import { CodeInput } from '@/components/form/code-input'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { ResendCode } from '@/components/form/resend-code'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/supabase/browser'
import { clearPending, savePending, usePending, type PendingCode } from './pending'

/** Code + new password after "Forgot password". Without a pending code, back to the email step. */
export function ResetForm() {
  const pending = usePending(['recovery'])
  const router = useRouter()
  useEffect(() => {
    if (pending === null) router.replace('/forgot')
  }, [pending, router])
  return pending ? <ResetPassword pending={pending} /> : null
}

function ResetPassword({ pending }: { pending: PendingCode }) {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const [state, flow] = useFlow(
    () => createPasswordReset({ auth: authClient(), email: pending.email, sentAt: pending.sentAt }),
    [pending.email],
  )
  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { code: '', password: '', confirmPassword: '' },
  })
  const busy = state.status !== 'idle'
  const errors = form.formState.errors
  const flowError = (field: 'code' | 'password') =>
    state.error?.field === field ? message(state.error.key) : undefined

  const submit = form.handleSubmit(async ({ code, password }) => {
    if (await flow.submit({ code, password })) {
      clearPending()
      toast.success(t('auth.reset.done'))
      router.replace('/')
      router.refresh()
    }
  })

  async function resend() {
    await flow.resend()
    const { resendAvailableAt, notice } = flow.getState()
    if (notice === 'resent') {
      savePending({ ...pending, sentAt: resendAvailableAt - AUTH_RESEND_COOLDOWN_SECONDS * 1000 })
    }
  }

  return (
    <AuthCard
      title={t('auth.reset.title')}
      description={<EmailText i18nKey="auth.verify.codeSentIfAccount" email={pending.email} />}
      footer={
        <div className="flex flex-col items-center gap-2">
          <Link href="/forgot" className="tap-area font-medium text-primary hover:underline">
            {t('auth.verify.wrongEmail')}
          </Link>
          <Link
            href="/login"
            className="-my-3 inline-flex min-h-11 items-center gap-1.5 py-3 font-medium text-primary hover:underline"
          >
            <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
            {t('auth.forgot.backToSignIn')}
          </Link>
        </div>
      }
    >
      {state.notice === 'resent' ? (
        <FormAlert tone="success" className="mb-5">
          {t('auth.verify.resent')}
        </FormAlert>
      ) : null}
      {state.error && !state.error.field ? (
        <FormAlert tone="error" className="mb-5">
          {message(state.error.key)}
        </FormAlert>
      ) : null}
      <form method="post" onSubmit={submit} noValidate className="space-y-5">
        {state.codeVerified ? null : (
          <TextField
            label={t('auth.fields.code')}
            error={message(errors.code?.message) ?? flowError('code')}
            render={(a11y) => (
              <Controller
                control={form.control}
                name="code"
                render={({ field }) => (
                  <CodeInput
                    {...a11y}
                    name={field.name}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={busy}
                    autoFocus
                  />
                )}
              />
            )}
          />
        )}
        <TextField
          label={t('auth.fields.newPassword')}
          description={t('auth.fields.passwordHint', { count: AUTH_PASSWORD_MIN_LENGTH })}
          error={message(errors.password?.message) ?? flowError('password')}
          render={(a11y) => (
            <PasswordInput autoComplete="new-password" {...a11y} {...form.register('password')} />
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
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {state.status === 'submitting' ? t('status.saving') : t('auth.reset.submit')}
        </Button>
      </form>
      {state.codeVerified ? null : (
        <div className="mt-6 space-y-1 border-t pt-5">
          <p className="text-sm text-muted-foreground">{t('auth.verify.noCode')}</p>
          <ResendCode
            availableAt={state.resendAvailableAt}
            busy={busy}
            onResend={() => void resend()}
          />
        </div>
      )}
    </AuthCard>
  )
}
