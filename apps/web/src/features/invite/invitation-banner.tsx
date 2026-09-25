'use client'

import { MailIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmailText } from '@/components/form/email-text'
import { isolate } from '@/components/form/use-message'
import { invitationHint, type InvitationHint } from './return-path'

/**
 * On the sign in and sign up pages, when this tab came from an invitation: which business it is for
 * and which (masked) email to use, so the visitor does not sign up with another address.
 */
export function InvitationBanner() {
  const { t } = useTranslation()
  // Read after the first render: sessionStorage exists only in the browser.
  const [hint, setHint] = useState<InvitationHint | null>(null)
  useEffect(() => setHint(invitationHint()), [])
  if (!hint) return null
  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-2.5 rounded-lg border border-primary/20 bg-accent/60 px-3 py-2.5 text-sm leading-relaxed"
    >
      <MailIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="font-medium">
          {t('auth.invite.bannerTitle', { businessName: isolate(hint.businessName) })}
        </p>
        <p className="text-muted-foreground">
          <EmailText i18nKey="auth.invite.bannerEmail" email={hint.maskedEmail} />
        </p>
      </div>
    </div>
  )
}
