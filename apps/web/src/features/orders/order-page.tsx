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
import { useBooks } from '@/features/sales/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { mayEnterOrders } from './data'
import { OrderEditor } from './order-editor'
import { OrderView } from './order-view'

// An order's pages (M3 Step 5): a new order (members who enter orders), one order as it is (with the
// actions the member may take), and a pending order changed. The API lets a member without "see every
// order" open only their own (D-265); another's is "not found".

/** An order page on its way (also its loading.tsx). */
export function OrderLoading() {
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
      <Link href={`/b/${businessId}/orders`}>
        {t('states.goTo', { section: t('common.nav.orders') })}
      </Link>
    </Button>
  )
}

function MayNotEnter() {
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

function NotFound() {
  const { t } = useTranslation()
  return (
    <PageContainer>
      <StatePanel
        icon={SearchXIcon}
        title={t('orders.view.notFound')}
        body={t('orders.view.notFoundBody')}
        documentTitle={`${t('orders.view.notFound')} · ${t('appName')}`}
      >
        <BackToList />
      </StatePanel>
    </PageContainer>
  )
}

function NewOrder() {
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!mayEnterOrders(context)) return <MayNotEnter />
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <OrderLoading />
  return <OrderEditor today={books.data.today} />
}

function OneOrder({ orderId, edit }: { orderId: string; edit: boolean }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const order = useQuery(trpc.order.get.queryOptions({ id: orderId }))
  if (!context) return null
  if (order.isError && apiErrorCode(order.error) === 'not_found') return <NotFound />
  const error = order.error ?? books.error
  if (error && (!order.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void order.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!order.data || !books.data) return <OrderLoading />
  // Only a pending order changes, by a member who enters orders; otherwise it shows as it is.
  if (edit && order.data.data.status === 'pending' && mayEnterOrders(context)) {
    return <OrderEditor key={order.data.data.id} order={order.data.data} today={books.data.today} />
  }
  return (
    <OrderView
      result={order.data}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
    />
  )
}

/** A new order, inside the module's gate. */
export function NewOrderPage() {
  return (
    <ModuleGate moduleId="orders" entryId="orders">
      <NewOrder />
    </ModuleGate>
  )
}

/** One order (or, `edit`, a pending one changed), inside the module's gate. */
export function OrderPage({ orderId, edit = false }: { orderId: string; edit?: boolean }) {
  return (
    <ModuleGate moduleId="orders" entryId="orders">
      <OneOrder orderId={orderId} edit={edit} />
    </ModuleGate>
  )
}
