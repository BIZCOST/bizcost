'use client'

import { CompassIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { useBusinessContext } from '@/lib/trpc/client'
import { shellNav } from './nav'
import { PageContainer } from './page-container'

/**
 * "Page not found" inside a business (a mistyped address, or a section that is not released): said
 * inside the shell, with a way to the member's first section.
 */
export function BusinessNotFound() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  const pathname = usePathname()
  const { data: context } = useBusinessContext()
  const first = context ? shellNav(context.modules, businessId, pathname)[0] : undefined
  return (
    <PageContainer>
      <StatePanel
        icon={CompassIcon}
        title={t('notFound.title')}
        body={t('notFound.body')}
        tone="accent"
        documentTitle={`${t('notFound.title')} · ${t('appName')}`}
      >
        {first ? (
          <Button asChild size="lg">
            <Link href={first.href}>{t('states.goTo', { section: t(first.labelKey) })}</Link>
          </Button>
        ) : null}
      </StatePanel>
    </PageContainer>
  )
}
