'use client'

import {
  emailFormSchema,
  requestSignInCode,
  signInSchema,
  signInWithPassword,
  type AuthMessageKey,
  type EmailForm,
  type SignInForm,
} from '@bizcost/app-core'
import { zodResolver } from '@hookform/resolvers/zod'
import { KeyRoundIcon, MailIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { savePending } from './pending'
import { NOTICE_KEYS, type Notice } from './notices'

type Method = 'password' | 'code'

function MethodSwitch({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  const { t } = useTranslation()
  const options = [
    { value: 'password' as const, label: t('auth.login.methodPassword'), icon: KeyRoundIcon },
    { value: 'code' as const, label: t('auth.login.methodCode'), icon: MailIcon },
  ]
  return (
    <fieldset className="mb-6">
      <legend className="sr-only">{t('auth.login.methodLabel')}</legend>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
        {options.map(({ value: option, label, icon: Icon }) => (
          <label
            key={option}
            className="relative flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-medium text-muted-foreground transition-colors has-checked:bg-card has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-3 has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name="login-method"
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            <Icon aria-hidden className="size-4" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function LoginForm({ notice }: { notice?: Notice }) {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const { locale } = useLocale()
  const [method, setMethod] = useState<Method>('password')
  const [error, setError] = useState<AuthMessageKey | null>(null)

  const passwordForm = useForm<SignInForm>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  })
  const codeForm = useForm<EmailForm>({
    resolver: zodResolver(emailFormSchema),
    defaultValues: { email: '' },
  })

  function switchMethod(next: Method) {
    // Keep the typed email when switching.
    if (next === 'code') codeForm.setValue('email', passwordForm.getValues('email'))
    else passwordForm.setValue('email', codeForm.getValues('email'))
    setError(null)
    setMethod(next)
  }

  const signIn = passwordForm.handleSubmit(async (values) => {
    setError(null)
    const result = await signInWithPassword(authClient(), values)
    if (!result.ok) return setError(result.error)
    if (result.next === 'confirmEmail') {
      savePending({
        email: result.email,
        purpose: 'signUp',
        sentAt: Date.now(),
        notice: 'confirmEmailFirst',
      })
      return router.push('/verify')
    }
    router.replace('/')
    router.refresh()
  })

  const sendCode = codeForm.handleSubmit(async (values) => {
    setError(null)
    // A new address gets an account, and its emails in the page language.
    const result = await requestSignInCode(authClient(), { ...values, locale })
    if (!result.ok) return setError(result.error)
    savePending({ email: result.email, purpose: 'signIn', sentAt: Date.now() })
    router.push('/verify')
  })

  const busy = passwordForm.formState.isSubmitting || codeForm.formState.isSubmitting

  return (
    <AuthCard
      title={t('auth.login.title')}
      description={t('auth.login.subtitle')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <Link href="/signup" className="tap-area font-medium text-primary hover:underline">
            {t('auth.login.createAccount')}
          </Link>
        </>
      }
    >
      {notice ? (
        <FormAlert tone="info" className="mb-5">
          {t(NOTICE_KEYS[notice])}
        </FormAlert>
      ) : null}
      <MethodSwitch value={method} onChange={switchMethod} />
      {error ? (
        <FormAlert tone="error" className="mb-5">
          {message(error)}
        </FormAlert>
      ) : null}

      {method === 'password' ? (
        <form method="post" onSubmit={signIn} noValidate className="space-y-5">
          <TextField
            label={t('auth.fields.email')}
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('auth.fields.emailPlaceholder')}
            error={message(passwordForm.formState.errors.email?.message)}
            {...passwordForm.register('email')}
          />
          <TextField
            label={t('auth.fields.password')}
            error={message(passwordForm.formState.errors.password?.message)}
            labelAction={
              <Link
                href="/forgot"
                className="tap-area text-sm font-medium text-primary hover:underline"
              >
                {t('auth.login.forgotPassword')}
              </Link>
            }
            render={(a11y) => (
              <PasswordInput
                autoComplete="current-password"
                {...a11y}
                {...passwordForm.register('password')}
              />
            )}
          />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {passwordForm.formState.isSubmitting ? t('status.signingIn') : t('auth.login.submit')}
          </Button>
        </form>
      ) : (
        <form method="post" onSubmit={sendCode} noValidate className="space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('auth.login.codeHint')}
          </p>
          <TextField
            label={t('auth.fields.email')}
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('auth.fields.emailPlaceholder')}
            error={message(codeForm.formState.errors.email?.message)}
            {...codeForm.register('email')}
          />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {codeForm.formState.isSubmitting ? t('status.sending') : t('auth.login.sendCode')}
          </Button>
        </form>
      )}
    </AuthCard>
  )
}
