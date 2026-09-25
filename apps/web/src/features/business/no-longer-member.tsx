'use client'

import { LockKeyholeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * A business that is not open to this member: removed from it, or it was removed. The API answers
 * both (and "no such business") with the same FORBIDDEN, so one message covers them. A full load
 * home refreshes `me` and the switcher.
 */
export function NoLongerMember() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <LockKeyholeIcon aria-hidden className="size-6" />
      </span>
      <h1 className="mt-5 text-xl font-semibold">{t('settings.lost.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('settings.lost.body')}</p>
      <Button asChild size="lg" className="mt-6">
        <a href="/">{t('notFound.home')}</a>
      </Button>
    </div>
  )
}
