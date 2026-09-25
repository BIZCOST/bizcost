'use client'

import {
  apiErrorCode,
  apiErrorKey,
  createIdentityCheck,
  signOut,
  useFlow,
  useTRPC,
  type AuthMessageKey,
} from '@bizcost/app-core'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { LogOutIcon, Trash2Icon } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeInput } from '@/components/form/code-input'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { ResendCode } from '@/components/form/resend-code'
import { useMessage } from '@/components/form/use-message'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'
import { Section } from './section'

export function SessionsSection() {
  const { t } = useTranslation()
  const message = useMessage()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AuthMessageKey | null>(null)

  async function signOutEverywhere() {
    setBusy(true)
    setError(null)
    const result = await signOut(authClient(), 'global')
    if (!result.ok) {
      setBusy(false)
      setError(result.error)
      return
    }
    window.location.assign('/login?notice=signed-out-everywhere')
  }

  return (
    <Section
      anchor="sessions"
      title={t('account.sessions.title')}
      description={t('account.sessions.description')}
    >
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogTrigger asChild>
          <Button variant="outline">
            <LogOutIcon aria-hidden className="rtl:rotate-180" />
            {t('account.sessions.action')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-accent text-primary">
              <LogOutIcon className="rtl:rotate-180" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('account.sessions.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('account.sessions.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <FormAlert tone="error">{message(error)}</FormAlert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
            <Button onClick={() => void signOutEverywhere()} disabled={busy}>
              {busy ? t('status.signingOut') : t('account.sessions.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

/**
 * Delete account. The API needs a recent sign-in (D-064): when it answers `reauth_required`, a
 * "confirm it's you" code is emailed and checked by Supabase Auth, then the deletion is sent again.
 */
export function DeleteAccountSection() {
  const { t } = useTranslation()
  const message = useMessage()
  const trpc = useTRPC()
  const email = useSessionEmail() ?? ''
  const codeId = useId()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const remove = useMutation(trpc.account.delete.mutationOptions())
  const [check, identity] = useFlow(
    () => createIdentityCheck({ auth: authClient(), email }),
    [email],
  )
  const askingCode = check.step === 'code'
  const busy = remove.isPending || remove.isSuccess || check.status !== 'idle'

  async function deleteAccount() {
    try {
      await remove.mutateAsync()
    } catch (error) {
      // Not signed in recently: email a code, and delete once it is confirmed.
      if (apiErrorCode(error) === 'reauth_required') {
        remove.reset()
        await identity.sendCode()
      }
      return // other errors are shown below
    }
    // The auth user is gone; forget the session on this device.
    await signOut(authClient(), 'local')
    window.location.assign('/login?notice=account-deleted')
  }

  async function confirmAndDelete() {
    if (await identity.confirm(code)) await deleteAccount()
  }

  const codeError =
    check.error === 'auth.errors.codeInvalid' || check.error === 'auth.validation.codeIncomplete'
      ? message(check.error)
      : undefined

  return (
    <Section
      anchor="delete"
      title={t('account.delete.title')}
      description={t('account.delete.description')}
      danger
    >
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          if (!next) {
            remove.reset()
            identity.reset()
            setCode('')
          }
          setOpen(next)
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="destructive">
            <Trash2Icon aria-hidden />
            {t('account.delete.action')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('account.delete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('account.delete.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError ? (
            <FormAlert tone="error">{t(apiErrorKey(remove.error) as I18nKey)}</FormAlert>
          ) : null}
          {check.error && !codeError ? (
            <FormAlert tone="error">{message(check.error)}</FormAlert>
          ) : null}
          {askingCode ? (
            <form
              id={`${codeId}-form`}
              method="post"
              noValidate
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void confirmAndDelete()
              }}
            >
              <FormAlert tone={check.notice === 'resent' ? 'success' : 'info'}>
                {check.notice === 'resent' ? (
                  t('auth.verify.resent')
                ) : (
                  <EmailText i18nKey="account.delete.codeSent" email={email} />
                )}
              </FormAlert>
              <Field data-invalid={Boolean(codeError) || undefined}>
                <FieldLabel htmlFor={codeId}>{t('auth.fields.code')}</FieldLabel>
                <CodeInput
                  id={codeId}
                  value={code}
                  onChange={setCode}
                  disabled={busy}
                  autoFocus
                  aria-invalid={Boolean(codeError)}
                  aria-describedby={codeError ? `${codeId}-error` : undefined}
                />
                {codeError ? <FieldError id={`${codeId}-error`}>{codeError}</FieldError> : null}
              </Field>
              <ResendCode
                availableAt={check.resendAvailableAt}
                busy={busy}
                onResend={() => void identity.sendCode()}
              />
            </form>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
            <Button
              type={askingCode ? 'submit' : 'button'}
              form={askingCode ? `${codeId}-form` : undefined}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={askingCode ? undefined : () => void deleteAccount()}
              disabled={busy}
            >
              {busy ? statusLabel(t, check.status) : t('account.delete.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function statusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: 'idle' | 'sending' | 'verifying',
): string {
  if (status === 'sending') return t('status.sending')
  if (status === 'verifying') return t('status.checking')
  return t('status.deleting')
}
