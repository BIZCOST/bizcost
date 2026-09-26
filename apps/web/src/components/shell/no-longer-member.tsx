'use client'

import { LockKeyholeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'

/**
 * A business that is not open to this member: removed from it, or it was removed. The API answers
 * both (and "no such business") with the same FORBIDDEN, so one message covers them. Shown under the
 * plain top bar (no sidebar: there is no business to show). A full load home refreshes `me` and the
 * switcher.
 */
export function NoLongerMember() {
  const { t } = useTranslation()
  return (
    <StatePanel
      icon={LockKeyholeIcon}
      title={t('business.lost.title')}
      body={t('business.lost.body')}
      card={false}
      className="py-16"
    >
      <Button asChild size="lg">
        <a href="/">{t('notFound.home')}</a>
      </Button>
    </StatePanel>
  )
}
