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
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { PurchaseEditor } from './purchase-editor'
import { PurchaseView } from './purchase-view'

// A purchase's page (M2 Step 3): a draft opens in the editor for members who may enter purchases
// (and may see its prices: a draft saved back without them would lose them); anything else is shown
// as it was recorded, with the actions the member may take.

/** A purchase page on its way (also its loading.tsx). */
export function PurchaseLoading() {
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
      <Link href={`/b/${businessId}/purchases`}>
        {t('states.goTo', { section: t('common.nav.purchases') })}
      </Link>
    </Button>
  )
}

/** Today and the books-closed date (every purchase page needs them). */
function useBooks() {
  const trpc = useTRPC()
  return useQuery(trpc.books.get.queryOptions())
}

function NewPurchase() {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!can(context, 'purchases.documents.manage')) {
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
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <PurchaseLoading />
  return <PurchaseEditor today={books.data.today} closedThrough={books.data.closedThrough} />
}

function OnePurchase({ purchaseId }: { purchaseId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const purchase = useQuery(trpc.purchase.get.queryOptions({ id: purchaseId }))
  if (!context) return null
  if (purchase.isError && apiErrorCode(purchase.error) === 'not_found') {
    return (
      <PageContainer>
        <StatePanel
          icon={SearchXIcon}
          title={t('purchasing.view.notFound')}
          body={t('purchasing.view.notFoundBody')}
          documentTitle={`${t('purchasing.view.notFound')} · ${t('appName')}`}
        >
          <BackToList />
        </StatePanel>
      </PageContainer>
    )
  }
  const error = purchase.error ?? books.error
  if (error && (!purchase.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void purchase.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!purchase.data || !books.data) return <PurchaseLoading />
  const result = purchase.data
  const editable =
    result.data.status === 'draft' &&
    can(context, 'purchases.documents.manage') &&
    result.meta.redacted.length === 0
  if (editable) {
    return (
      <PurchaseEditor
        key={result.data.id}
        purchase={result.data}
        today={books.data.today}
        closedThrough={books.data.closedThrough}
      />
    )
  }
  return (
    <PurchaseView
      result={result}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
    />
  )
}

/** A new purchase, inside the module's gate. */
export function NewPurchasePage() {
  return (
    <ModuleGate moduleId="purchases" entryId="purchases">
      <NewPurchase />
    </ModuleGate>
  )
}

/** One purchase, inside the module's gate. */
export function PurchasePage({ purchaseId }: { purchaseId: string }) {
  return (
    <ModuleGate moduleId="purchases" entryId="purchases">
      <OnePurchase purchaseId={purchaseId} />
    </ModuleGate>
  )
}
