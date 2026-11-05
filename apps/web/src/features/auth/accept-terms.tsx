'use client'

import type { ComponentProps } from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { FieldError } from '@/components/ui/field'

const LINK = 'font-medium text-primary underline underline-offset-2'

/**
 * The sign-up form's box (D-358): the terms of use and the privacy policy, each opening in a new tab so
 * the form keeps what was typed.
 */
export function AcceptTerms({
  error,
  ...input
}: { error?: string | undefined } & ComponentProps<'input'>) {
  const { t } = useTranslation()
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div>
      <div className="flex items-start gap-3">
        <input
          {...input}
          id={id}
          type="checkbox"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <label htmlFor={id} className="text-sm leading-relaxed">
          {t('auth.signup.acceptBefore')}{' '}
          <a href="/terms" target="_blank" rel="noreferrer" className={LINK}>
            {t('auth.signup.acceptTerms')}
          </a>{' '}
          {t('auth.signup.acceptAnd')}{' '}
          <a href="/privacy" target="_blank" rel="noreferrer" className={LINK}>
            {t('auth.signup.acceptPrivacy')}
          </a>{' '}
          {t('auth.signup.acceptAfter')}
        </label>
      </div>
      {error ? (
        <FieldError id={errorId} className="mt-1.5">
          {error}
        </FieldError>
      ) : null}
    </div>
  )
}
