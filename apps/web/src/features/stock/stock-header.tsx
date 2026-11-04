'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { maySeeStock } from './data'

// The top of the Stock section (M4 Step 2): its title, a line saying what the page is, its actions,
// and for a member who sees stock the two pages, "On hand" and "Counts". A member who only counts
// (blind, Q6) has the counts alone, so no tabs.

export function StockHeader({
  current,
  intro,
  actions,
}: {
  current: 'onHand' | 'counts'
  intro: string
  /** At the end of the title (buttons). */
  actions?: ReactNode
}) {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const tabs = context !== undefined && maySeeStock(context)
  const base = `/b/${businessId}/stock`
  return (
    <>
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('common.nav.stock')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">{intro}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </header>
      {tabs ? (
        <nav aria-label={t('stock.tabs.label')} className="mb-5">
          <ul className="flex gap-1 rounded-lg bg-muted p-1 sm:inline-flex">
            {(['onHand', 'counts'] as const).map((tab) => (
              <li key={tab} className="flex-1 sm:flex-none">
                <Link
                  href={tab === 'onHand' ? base : `${base}/counts`}
                  aria-current={tab === current ? 'page' : undefined}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
                    tab === current && 'bg-card text-foreground shadow-sm',
                  )}
                >
                  {t(`stock.tabs.${tab}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </>
  )
}
