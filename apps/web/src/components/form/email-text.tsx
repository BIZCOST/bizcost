'use client'

import type { I18nKey } from '@bizcost/i18n'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SLOT } from './slot-text'

/** Punctuation right after the address stays on its line (e.g. the sentence's full stop). */
const TRAILING_PUNCTUATION = /^[.,،؛;:!?)]*/

/**
 * An email address inside text: one left-to-right unit that moves to the next line as a whole (and
 * only breaks when it is wider than the line), so in Arabic it is never split at a hyphen with its
 * parts on two sides. `after` is punctuation that must not wrap away from it.
 */
export function Email({ children, after }: { children: string; after?: ReactNode }) {
  return (
    <span className="inline-block max-w-full align-bottom break-all">
      <bdi dir="ltr">{children}</bdi>
      {after}
    </span>
  )
}

/** A translated sentence with `{{email}}` in it, the address rendered by <Email>. */
export function EmailText({
  i18nKey,
  email,
}: {
  i18nKey: Extract<
    I18nKey,
    | 'auth.verify.signUpBody'
    | 'auth.verify.codeSent'
    | 'auth.verify.codeSentIfAccount'
    | 'account.password.codeSent'
    | 'account.delete.codeSent'
    | 'account.email.changed'
  >
  email: string
}) {
  const { t } = useTranslation()
  const [before = '', rest = ''] = t(i18nKey, { email: SLOT }).split(SLOT)
  const punctuation = TRAILING_PUNCTUATION.exec(rest)?.[0] ?? ''
  return (
    <>
      {before}
      <Email after={punctuation}>{email}</Email>
      {rest.slice(punctuation.length)}
    </>
  )
}
