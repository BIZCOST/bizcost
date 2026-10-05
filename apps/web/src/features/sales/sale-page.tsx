'use client'

import { apiErrorCode, useTRPC } from '@bizcost/app-core'
import { useQuery } from '@tanstack/react-query'
import { LockKeyholeIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { useBusinessContext } from '@/lib/trpc/client'
import { mayEnterSales, useBooks } from './data'
import { SaleEditor } from './sale-editor'
import { SaleView } from './sale-view'

// A sale's page (M3 Step 2): One sale's draft opens in the editor for members who enter sales (the
// API lets a member without "see every sale" open only their own, D-231); a draft sheet opens in
// Today's sales from its page; anything else is shown as it was recorded, with the actions the
// member may take.

/** A sale page on its way (also its loading.tsx). */
export function SaleLoading() {
  return (
    <PageContainer>
      <SectionSkeleton cards={3} />
    </PageContainer>
  )
}

function BackToList() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  return (
    <Button asChild variant="outline" size="lg">
      <Link href={`/b/${businessId}/sales`}>
        {t('states.goTo', { section: t('common.nav.sales') })}
      </Link>
    </Button>
  )
}

/** The member may not enter sales: the page says so, with the way back to Sales. */
export function MayNotEnter() {
  const { t } = useTranslation()
  return (
    <PageContainer>
      <StatePanel
        icon={LockKeyholeIcon}
        title={t('states.forbidden.title')}
        body={t('states.forbidden.body')}
        documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
      >
        <BackToList />
      </StatePanel>
    </PageContainer>
  )
}

function NewSale() {
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!mayEnterSales(context)) return <MayNotEnter />
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <SaleLoading />
  return <SaleEditor today={books.data.today} closedThrough={books.data.closedThrough} />
}

function OneSale({ saleId }: { saleId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const sale = useQuery(trpc.sale.get.queryOptions({ id: saleId }))
  if (!context) return null
  if (sale.isError && apiErrorCode(sale.error) === 'not_found') {
    return (
      <PageContainer>
        <StatePanel
          icon={SearchXIcon}
          title={t('sales.view.notFound')}
          body={t('sales.view.notFoundBody')}
          documentTitle={`${t('sales.view.notFound')} · ${t('appName')}`}
        >
          <BackToList />
        </StatePanel>
      </PageContainer>
    )
  }
  const error = sale.error ?? books.error
  if (error && (!sale.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void sale.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!sale.data || !books.data) return <SaleLoading />
  const result = sale.data
  if (result.data.status === 'draft' && result.data.source === 'single' && mayEnterSales(context)) {
    return (
      <SaleEditor
        key={result.data.id}
        sale={result.data}
        today={books.data.today}
        closedThrough={books.data.closedThrough}
      />
    )
  }
  return (
    <SaleView result={result} today={books.data.today} closedThrough={books.data.closedThrough} />
  )
}

/** A new sale, inside the module's gate. */
export function NewSalePage() {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <NewSale />
    </ModuleGate>
  )
}

/** One sale, inside the module's gate. */
export function SalePage({ saleId }: { saleId: string }) {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <OneSale saleId={saleId} />
    </ModuleGate>
  )
}
