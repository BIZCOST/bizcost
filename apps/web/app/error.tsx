'use client'

import { TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LanguageMenu } from '@/components/language-menu'
import { Button } from '@/components/ui/button'

// Unexpected rendering errors. Never shows the error's text (it may hold server details).
export default function ErrorPage({ reset }: { reset: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-[60dvh] flex-col">
      <div className="flex justify-end px-4 pt-4 sm:px-8 sm:pt-6">
        <LanguageMenu />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-12 text-center">
        <title>{t('errorPage.title')}</title>
        <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <TriangleAlertIcon aria-hidden className="size-7" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('errorPage.title')}</h1>
          <p className="text-muted-foreground">{t('errors.internal')}</p>
        </div>
        <Button size="lg" onClick={reset}>
          {t('actions.tryAgain')}
        </Button>
      </main>
    </div>
  )
}
