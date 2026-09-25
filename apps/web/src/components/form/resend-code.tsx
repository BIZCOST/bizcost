'use client'

import { useCountdown } from '@bizcost/app-core'
import type { I18nKey } from '@bizcost/i18n'
import { RotateCwIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

type WaitKey = Extract<I18nKey, 'auth.verify.resendIn' | 'account.email.resendCodesIn'>

/**
 * "Send a new code", available once the cooldown is over; until then the seconds left. Screen readers
 * hear the wait once when it starts and once when it ends, never every second.
 */
export function ResendCode({
  availableAt,
  busy,
  onResend,
  label,
  waitKey = 'auth.verify.resendIn',
}: {
  /** Epoch ms when a new code may be requested. */
  availableAt: number
  busy: boolean
  onResend: () => void
  label?: string
  /** The countdown sentence (plural `count`), e.g. "new codes" for the email change. */
  waitKey?: WaitKey
}) {
  const { t } = useTranslation()
  const seconds = useCountdown(availableAt)
  const waiting = seconds > 0
  // The wait as it was when it started (adjusted while rendering, once per new wait).
  const [started, setStarted] = useState({ availableAt, seconds })
  if (waiting && started.availableAt !== availableAt) setStarted({ availableAt, seconds })
  const announcement = waiting
    ? t(waitKey, { count: started.availableAt === availableAt ? started.seconds : seconds })
    : t('auth.verify.resendReady')

  return (
    <div className="min-h-11 content-center">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {waiting ? (
        <p aria-hidden className="text-sm text-muted-foreground">
          {t(waitKey, { count: seconds })}
        </p>
      ) : (
        <Button
          type="button"
          variant="link"
          className="h-11 px-0 text-sm lg:pointer-fine:h-11 lg:pointer-fine:px-0"
          onClick={onResend}
          disabled={busy}
        >
          <RotateCwIcon aria-hidden className="size-3.5" />
          {label ?? t('auth.verify.resend')}
        </Button>
      )}
    </div>
  )
}
