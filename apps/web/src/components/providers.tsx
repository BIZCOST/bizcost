'use client'

import { dir as directionOf, type Locale, type MessageBundle } from '@bizcost/i18n'
import type { ReactNode } from 'react'
import { DirectionProvider } from '@/components/ui/direction'
import { Toaster } from '@/components/ui/sonner'
import { I18nProvider } from '@/lib/i18n/client'

/**
 * Providers every page needs: translations (the root messages of the page's language, D-092), text
 * direction (Radix) and toasts.
 */
export function Providers({
  locale,
  messages,
  children,
}: {
  locale: Locale
  messages: MessageBundle
  children: ReactNode
}) {
  const dir = directionOf(locale)
  return (
    <I18nProvider locale={locale} messages={messages}>
      <DirectionProvider dir={dir}>
        {children}
        <Toaster dir={dir} position="top-center" richColors={false} closeButton={false} />
      </DirectionProvider>
    </I18nProvider>
  )
}
