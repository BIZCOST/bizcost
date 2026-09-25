'use client'

import { dir as directionOf, type Locale } from '@bizcost/i18n'
import type { ReactNode } from 'react'
import { DirectionProvider } from '@/components/ui/direction'
import { Toaster } from '@/components/ui/sonner'
import { I18nProvider } from '@/lib/i18n/client'

/** Providers every page needs: translations, text direction (Radix) and toasts. */
export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  const dir = directionOf(locale)
  return (
    <I18nProvider locale={locale}>
      <DirectionProvider dir={dir}>
        {children}
        <Toaster dir={dir} position="top-center" richColors={false} closeButton={false} />
      </DirectionProvider>
    </I18nProvider>
  )
}
