'use client'

import { createCodeVerification, useFlow } from '@bizcost/app-core'
import { AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { InfoIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { SLOT, SlotText } from '@/components/form/slot-text'
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
        retryAt: pending.retryAt,
      }),
    [pending.email, pending.purpose],
  )
  const busy = state.status !== 'idle'
  const codeError =
    state.error === 'auth.errors.codeInvalid' || state.error === 'auth.validation.codeIncomplete'

  // Keep the countdown and a planned automatic resend (D-073, run once) across a reload of this tab.
  const { resendAvailableAt, retryAt } = state
  const verified = state.status === 'verified'
  useEffect(() => {
    if (verified) return
    savePending({
      ...pending,
      sentAt: resendAvailableAt - AUTH_RESEND_COOLDOWN_SECONDS * 1000,
      retryAt: retryAt ?? undefined,
    })
  }, [pending, verified, resendAvailableAt, retryAt])

  async function verify(value: string) {
    if (await flow.verify(value)) {
      clearPending()
      router.replace('/')
      router.refresh()
    }
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
      onVerify={(code) => void verify(code)}
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
