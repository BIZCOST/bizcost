'use client'

import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { StatePanel } from './state-panel'

/**
 * An unexpected error while showing a page (error.tsx boundaries). Never shows the error's text: it
 * may hold server details. `card` inside the business shell, bare on a page of its own.
 */
export function ErrorState({ onRetry, card }: { onRetry: () => void; card: boolean }) {
  const { t } = useTranslation()
  return (
    <StatePanel
      icon={TriangleAlertIcon}
      title={t('errorPage.title')}
      body={t('errors.internal')}
      tone="destructive"
      card={card}
      documentTitle={`${t('errorPage.title')} · ${t('appName')}`}
      className={card ? undefined : 'py-16'}
    >
      <Button size="lg" onClick={onRetry}>
        <RotateCwIcon aria-hidden />
        {t('actions.tryAgain')}
      </Button>
    </StatePanel>
  )
}
