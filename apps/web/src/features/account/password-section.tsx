'use client'

import {
  changePasswordSchema,
  createPasswordChange,
  useFlow,
  type ChangePasswordForm,
  type PasswordChange,
  type PasswordChangeState,
} from '@bizcost/app-core'
import { AUTH_PASSWORD_MIN_LENGTH } from '@bizcost/contracts'
import { zodResolver } from '@hookform/resolvers/zod'
import { KeyRoundIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CodeInput } from '@/components/form/code-input'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { ResendCode } from '@/components/form/resend-code'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'
import { Section } from './section'

// Change password with a "confirm it's you" code emailed first and checked by Supabase Auth
// (app-core createPasswordChange, D-063).

export function PasswordSection() {
  const { t } = useTranslation()
  const message = useMessage()
  const email = useSessionEmail() ?? ''
  const [state, flow] = useFlow(() => createPasswordChange({ auth: authClient(), email }), [email])

  useEffect(() => {
    if (state.step !== 'done') return
    toast.success(t('account.password.changed'))
    flow.cancel()
  }, [state.step, flow, t])

  return (
    <Section
      anchor="password"
      title={t('account.password.title')}
      description={t('account.password.description')}
    >
      {state.step === 'code' ? (
        <PasswordCodeForm flow={flow} state={state} />
      ) : (
        <div className="space-y-4">
          {state.error ? <FormAlert tone="error">{message(state.error.key)}</FormAlert> : null}
          <Button
            variant="outline"
            onClick={() => void flow.sendCode()}
            disabled={state.status !== 'idle'}
          >
            <KeyRoundIcon aria-hidden />
            {state.status === 'sending' ? t('status.sending') : t('account.password.change')}
          </Button>
        </div>
      )}
    </Section>
  )
}

function PasswordCodeForm({ flow, state }: { flow: PasswordChange; state: PasswordChangeState }) {
  const { t } = useTranslation()
  const message = useMessage()
  const email = useSessionEmail() ?? ''
  const form = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { code: '', password: '', confirmPassword: '' },
  })
  const busy = state.status !== 'idle'
  const errors = form.formState.errors
  const flowError = (field: 'code' | 'password') =>
    state.error?.field === field ? message(state.error.key) : undefined
  const submit = form.handleSubmit(({ code, password }) => flow.submit({ code, password }))

  return (
    <form method="post" onSubmit={submit} noValidate className="space-y-5">
      <FormAlert tone={state.notice === 'resent' ? 'success' : 'info'}>
        {state.notice === 'resent' ? (
          t('auth.verify.resent')
        ) : (
          <EmailText i18nKey="account.password.codeSent" email={email} />
        )}
      </FormAlert>
      {state.error && !state.error.field ? (
        <FormAlert tone="error">{message(state.error.key)}</FormAlert>
      ) : null}
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        {state.codeVerified ? null : (
          <ResendCode
            availableAt={state.resendAvailableAt}
            busy={busy}
            onResend={() => void flow.sendCode()}
          />
        )}
        <div className="ms-auto flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => flow.cancel()} disabled={busy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {state.status === 'submitting' ? t('status.saving') : t('account.password.submit')}
          </Button>
        </div>
      </div>
    </form>
  )
}
