'use client'

import { passwordChecks, type PasswordChecks } from '@bizcost/app-core'
import { AUTH_PASSWORD_MIN_LENGTH } from '@bizcost/contracts'
import { CircleCheckIcon, CircleIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SLOT, SlotText } from './slot-text'

/** Latin text (a-z, 0-9) read left to right inside an Arabic sentence too, never split across lines. */
function Ltr({ children }: { children: ReactNode }) {
  return (
    <bdi dir="ltr" className="whitespace-nowrap">
      {children}
    </bdi>
  )
}

/**
 * The new-password rule under the field (D-072): the hint (`id`: the input is described by it) and a
 * live checklist of the three rules that the Auth server enforces. Each rule turns into a check (icon
 * and color) as it is met; screen readers hear only when the whole rule becomes met or unmet again.
 */
export function PasswordRules({ id, password }: { id: string; password: string }) {
  const { t } = useTranslation()
  const checks = passwordChecks(password)
  const valid = checks.length && checks.letter && checks.digit
  // Nothing is announced before the first change (an empty field is not news).
  const [status, setStatus] = useState<{ valid: boolean; changed: boolean }>({
    valid,
    changed: false,
  })
  if (status.valid !== valid) setStatus({ valid, changed: true })

  const rules: { check: keyof PasswordChecks; label: ReactNode }[] = [
    { check: 'length', label: t('auth.passwordRules.length', { count: AUTH_PASSWORD_MIN_LENGTH }) },
    {
      check: 'letter',
      label: (
        <SlotText text={t('auth.passwordRules.letter', { range: SLOT })} value={<Ltr>a-z</Ltr>} />
      ),
    },
    {
      check: 'digit',
      label: (
        <SlotText text={t('auth.passwordRules.digit', { range: SLOT })} value={<Ltr>0-9</Ltr>} />
      ),
    },
  ]

  return (
    <div className="space-y-1.5">
      <p id={id} className="text-sm leading-normal text-muted-foreground">
        <SlotText
          text={t('auth.passwordRules.hint', { count: AUTH_PASSWORD_MIN_LENGTH, chars: SLOT })}
          value={<Ltr>{t('auth.passwordRules.chars')}</Ltr>}
        />
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rules.map(({ check, label }) => {
          const met = checks[check]
          const Icon = met ? CircleCheckIcon : CircleIcon
          return (
            <li
              key={check}
              data-rule={check}
              data-met={met}
              className={cn(
                'inline-flex items-center gap-1',
                met ? 'text-success' : 'text-muted-foreground',
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span>{label}</span>{' '}
              <span className="sr-only">
                {met ? t('auth.passwordRules.met') : t('auth.passwordRules.unmet')}
              </span>
            </li>
          )
        })}
      </ul>
      <p role="status" className="sr-only">
        {status.changed
          ? t(valid ? 'auth.passwordRules.allMet' : 'auth.passwordRules.notAllMet')
          : null}
      </p>
    </div>
  )
}
