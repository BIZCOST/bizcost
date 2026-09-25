'use client'

import {
  changeEmailSchema,
  createEmailChange,
  emailCodesSchema,
  useFlow,
  useFlowState,
  type ChangeEmailForm,
  type EmailChange,
  type EmailCodesForm,
} from '@bizcost/app-core'
import { zodResolver } from '@hookform/resolvers/zod'
import { MailIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CodeInput } from '@/components/form/code-input'
import { Email, EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { ResendCode } from '@/components/form/resend-code'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'
import { Section } from './section'

// Secure email change: a code to the current address and one to the new address (app-core
// createEmailChange). The new email shows once the session is refreshed from the server.

export function EmailSection() {
  const { t } = useTranslation()
  const email = useSessionEmail() ?? ''
  // A new flow for a new email (after a change) or after closing the form.
  const [generation, setGeneration] = useState(0)
  const [state, flow] = useFlow(
    () => createEmailChange({ auth: authClient(), currentEmail: email }),
    [email, generation],
  )
  const [editing, setEditing] = useState(false)

  function close() {
    setEditing(false)
    setGeneration((value) => value + 1)
  }

  return (
    <Section
      anchor="email"
      title={t('account.email.title')}
      description={t('account.email.description')}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t('account.email.current')}</p>
              <p
                dir="ltr"
                className="truncate text-sm font-medium rtl:text-end"
                data-testid="current-email"
              >
                {email}
              </p>
            </div>
          </div>
          {state.step === 'start' && !editing ? (
            <Button variant="outline" onClick={() => setEditing(true)}>
              {t('account.email.change')}
            </Button>
          ) : null}
        </div>
        {state.step === 'start' && editing ? <NewEmailForm flow={flow} onCancel={close} /> : null}
        {state.step !== 'start' ? <EmailCodesForm flow={flow} onClose={close} /> : null}
      </div>
    </Section>
  )
}

function NewEmailForm({ flow, onCancel }: { flow: EmailChange; onCancel: () => void }) {
  const { t } = useTranslation()
  const message = useMessage()
  const state = useFlowState(flow)
  const form = useForm<ChangeEmailForm>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { newEmail: '' },
  })
  const submit = form.handleSubmit(({ newEmail }) => flow.sendCodes(newEmail))
  const flowError = state.error?.field === 'newEmail' ? message(state.error.key) : undefined

  return (
    <form method="post" onSubmit={submit} noValidate className="space-y-4">
      {state.error && !state.error.field ? (
        <FormAlert tone="error">{message(state.error.key)}</FormAlert>
      ) : null}
      <TextField
        label={t('account.email.newEmail')}
        type="email"
        dir="ltr"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t('auth.fields.emailPlaceholder')}
        autoFocus
        error={message(form.formState.errors.newEmail?.message) ?? flowError}
        {...form.register('newEmail')}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
        <Button type="submit" disabled={state.status !== 'idle'}>
          {state.status === 'sending' ? t('status.sending') : t('account.email.sendCodes')}
        </Button>
      </div>
    </form>
  )
}

type CodeField = 'currentCode' | 'newCode'

function EmailCodesForm({ flow, onClose }: { flow: EmailChange; onClose: () => void }) {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const state = useFlowState(flow)
  const form = useForm<EmailCodesForm>({
    resolver: zodResolver(emailCodesSchema),
    defaultValues: { currentCode: '', newCode: '' },
  })
  const busy = state.status !== 'idle'

  useEffect(() => {
    if (state.step !== 'done') return
    toast.success(<EmailText i18nKey="account.email.changed" email={state.currentEmail} />)
    onClose()
    // The layout reads the new email from the refreshed session.
    router.refresh()
  }, [state.step, state.currentEmail, onClose, router, t])

  const submit = form.handleSubmit((codes) => flow.submit(codes))
  const fieldError = (field: CodeField) =>
    message(form.formState.errors[field]?.message) ??
    (state.error?.field === field ? message(state.error.key) : undefined)

  // The address goes on its own line under the label, so it never splits across lines.
  const codeField = (field: CodeField, label: string, email: string, autoFocus: boolean) => (
    <TextField
      label={
        <span className="flex min-w-0 flex-col">
          <span>{label}</span>
          <span className="text-sm font-normal text-muted-foreground">
            <Email>{email}</Email>
          </span>
        </span>
      }
      error={fieldError(field)}
      render={(a11y) => (
        <Controller
          control={form.control}
          name={field}
          render={({ field: input }) => (
            <CodeInput
              {...a11y}
              name={input.name}
              value={input.value}
              onChange={input.onChange}
              disabled={busy}
              autoFocus={autoFocus}
            />
          )}
        />
      )}
    />
  )

  if (state.step === 'done') return null

  return (
    <form method="post" onSubmit={submit} noValidate className="space-y-5">
      <FormAlert tone={state.notice === 'resent' ? 'success' : 'info'}>
        {state.notice === 'resent' ? t('auth.verify.resent') : t('account.email.codesSent')}
      </FormAlert>
      {state.error && !state.error.field ? (
        <FormAlert tone="error">{message(state.error.key)}</FormAlert>
      ) : null}
      {state.currentCodeVerified
        ? null
        : codeField('currentCode', t('account.email.currentCode'), state.currentEmail, true)}
      {state.newCodeVerified
        ? null
        : codeField(
            'newCode',
            t('account.email.newCode'),
            state.newEmail ?? '',
            state.currentCodeVerified,
          )}
      <p className="text-sm text-muted-foreground">{t('account.email.noCodes')}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ResendCode
          availableAt={state.resendAvailableAt}
          busy={busy}
          onResend={() => void flow.sendCodes()}
          label={t('account.email.resendCodes')}
          waitKey="account.email.resendCodesIn"
        />
        <div className="ms-auto flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {state.status === 'submitting' ? t('status.saving') : t('account.email.submit')}
          </Button>
        </div>
      </div>
    </form>
  )
}
