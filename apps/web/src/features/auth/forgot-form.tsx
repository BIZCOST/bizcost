'use client'

import {
  emailFormSchema,
  requestPasswordReset,
  type AuthMessageKey,
  type EmailForm,
} from '@bizcost/app-core'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/supabase/browser'
import { readPending, savePending, usePending } from './pending'

export function ForgotForm() {
  const { t } = useTranslation()
  const message = useMessage()
  const router = useRouter()
  const [error, setError] = useState<AuthMessageKey | null>(null)
  // Back from /reset after the code signed the user in (the browser shows this page from its
  // cache, without the proxy): return to /reset, which lets them continue.
  const pending = usePending(['recovery'])
  useEffect(() => {
    if (!pending?.verified) return
    let active = true
    void authClient()
      .getSession()
      .then(({ data }) => {
        if (active && data.session) router.replace('/reset')
      })
    return () => {
      active = false
    }
  }, [pending, router])
  const form = useForm<EmailForm>({
    resolver: zodResolver(emailFormSchema),
    defaultValues: { email: '' },
  })

  const submit = form.handleSubmit(async (values) => {
    setError(null)
    const result = await requestPasswordReset(authClient(), values)
    if (!result.ok) return setError(result.error)
    // A new password stays required for this address when an earlier code in this tab required it.
    const previous = readPending()
    const required =
      previous?.purpose === 'recovery' &&
      previous.email === result.email &&
      previous.passwordRequired === true
    savePending({
      email: result.email,
      purpose: 'recovery',
      sentAt: Date.now(),
      ...(required ? { passwordRequired: true as const } : {}),
    })
    router.push('/reset')
  })

  return (
    <AuthCard
      title={t('auth.forgot.title')}
      description={t('auth.forgot.subtitle')}
      footer={
        <Link
          href="/login"
          className="-my-3 inline-flex min-h-11 items-center gap-1.5 py-3 font-medium text-primary hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
          {t('auth.forgot.backToSignIn')}
        </Link>
      }
    >
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
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('status.sending') : t('auth.forgot.submit')}
        </Button>
      </form>
    </AuthCard>
  )
}
