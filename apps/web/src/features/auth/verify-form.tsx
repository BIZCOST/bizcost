'use client'

import { createCodeVerification, useFlow } from '@bizcost/app-core'
import { AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { useMessage } from '@/components/form/use-message'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { CodeCard } from './code-card'
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
  const { locale } = useLocale()
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
        ) : null
      }
      codeError={codeError ? message(state.error) : undefined}
      formError={state.error && !codeError ? message(state.error) : undefined}
      checking={state.status === 'verifying' || state.status === 'verified'}
      busy={busy}
      resent={state.notice === 'resent'}
      resendAvailableAt={state.resendAvailableAt}
      onVerify={(code) => void verify(code)}
      onResend={() => void resend()}
      wrongEmailHref={signUp ? '/signup' : '/login'}
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
    />
  )
}
