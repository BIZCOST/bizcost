'use client'

import {
  isPasswordMessage,
  signUp,
  signUpSchema,
  type AuthMessageKey,
  type SignUpForm,
} from '@bizcost/app-core'
import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { FormAlert } from '@/components/form/form-alert'
import { PasswordInput } from '@/components/form/password-input'
import { PasswordRules } from '@/components/form/password-rules'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { InvitationBanner } from '@/features/invite/invitation-banner'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { savePending, sentCode } from './pending'

export function SignupForm() {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const { locale } = useLocale()
  const [error, setError] = useState<AuthMessageKey | null>(null)
  const form = useForm<SignUpForm>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { email: '', password: '' },
  })
  const password = useWatch({ control: form.control, name: 'password' })

  const submit = form.handleSubmit(async (values) => {
    setError(null)
    // The auth emails are written in the language the user signed up in. Signed up again within a
    // minute, the sign-up code this tab sent still works (D-073).
    const result = await signUp(authClient(), { ...values, locale, sent: sentCode('signUp') })
    if (!result.ok) {
      // The Auth server refused the password (its rule, D-072): the message goes under the field.
      if (isPasswordMessage(result.error)) {
        return form.setError('password', { message: result.error }, { shouldFocus: true })
      }
      return setError(result.error)
    }
    savePending({ email: result.email, purpose: 'signUp', sentAt: Date.now() })
    router.push('/verify')
  })

  return (
    <AuthCard
      title={t('auth.signup.title')}
      description={t('auth.signup.subtitle')}
      footer={
        <>
          {t('auth.signup.haveAccount')}{' '}
          <Link href="/login" className="tap-area font-medium text-primary hover:underline">
            {t('auth.signup.signIn')}
          </Link>
        </>
      }
    >
      <InvitationBanner />
      {error ? (
        <FormAlert tone="error" className="mb-5">
          {message(error)}
        </FormAlert>
      ) : null}
      <form method="post" onSubmit={submit} noValidate className="space-y-5">
        <TextField
          label={t('auth.fields.email')}
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t('auth.fields.emailPlaceholder')}
          error={message(form.formState.errors.email?.message)}
          {...form.register('email')}
        />
        <TextField
          label={t('auth.fields.password')}
          hint={(id) => <PasswordRules id={id} password={password} />}
          error={message(form.formState.errors.password?.message)}
          render={(a11y) => (
            <PasswordInput autoComplete="new-password" {...a11y} {...form.register('password')} />
          )}
        />
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('status.creatingAccount') : t('auth.signup.submit')}
        </Button>
      </form>
    </AuthCard>
  )
}
