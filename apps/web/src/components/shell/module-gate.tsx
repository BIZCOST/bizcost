'use client'

import { LockKeyholeIcon, PowerOffIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { can, sectionPath } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { moduleAccess, shellNav, wayBack } from './nav'
import { PageContainer } from './page-container'

/**
 * A module's page, shown only when the module is on for the business and the member may use its
 * entry `entryId`; otherwise the "turned off" or "not open to you" state (the API refuses the same:
 * MODULE_DISABLED, FORBIDDEN), with a way to another section of the shell. Wrap each module's pages in
 * it.
 */
export function ModuleGate({
  moduleId,
  entryId,
  children,
}: {
  moduleId: string
  entryId: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  const pathname = usePathname()
  const { data: context } = useBusinessContext()
  if (!context) return null
  const access = moduleAccess(context.modules, moduleId, entryId)
  if (access === 'open') return children
  const back = wayBack(shellNav(context.modules, businessId, pathname), moduleId)
  const backLink = back ? (
    <Button asChild variant="outline" size="lg">
      <Link href={back.href}>{t('states.goTo', { section: t(back.labelKey) })}</Link>
    </Button>
  ) : null
  if (access === 'forbidden') {
    return (
      <PageContainer>
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('states.forbidden.title')}
          body={t('states.forbidden.body')}
          documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
        >
          {backLink}
        </StatePanel>
      </PageContainer>
    )
  }
  const canTurnOn = can(context, 'settings.modules.manage')
  return (
    <PageContainer>
      <StatePanel
        icon={PowerOffIcon}
        title={t('states.moduleOff.title')}
        body={
          <>
            {t('states.moduleOff.body')} {canTurnOn ? null : t('states.moduleOff.ask')}
          </>
        }
        documentTitle={`${t('states.moduleOff.title')} · ${t('appName')}`}
      >
        {backLink}
        {canTurnOn ? (
          <Button asChild size="lg">
            <Link href={sectionPath(businessId, 'modules')}>{t('states.moduleOff.turnOn')}</Link>
          </Button>
        ) : null}
      </StatePanel>
    </PageContainer>
  )
}
