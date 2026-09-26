import 'server-only'
import { pickMessages, type MessageSpec } from '@bizcost/i18n'
import type { ReactNode } from 'react'
import { AddMessages } from './client'
import { getLocale } from './server'

/**
 * Gives the browser the messages of `specs` (in the request's language) for everything below it
 * (D-092). Put it in the layout or page whose route needs them; the specs live in ./route-messages.ts.
 * A loading.tsx shows inside its segment's layout, so a namespace its placeholder needs goes in the
 * layout, not in the page.
 */
export async function Messages({
  specs,
  children,
}: {
  specs: readonly MessageSpec[]
  children: ReactNode
}) {
  const locale = await getLocale()
  return (
    <AddMessages locale={locale} messages={pickMessages(locale, specs)}>
      {children}
    </AddMessages>
  )
}
