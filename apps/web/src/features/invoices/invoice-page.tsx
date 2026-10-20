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
import { mayManageInvoices } from './data'
import { InvoiceEditor } from './invoice-editor'
import { InvoiceView } from './invoice-view'
import { StartFrom } from './source-picker'

// An invoice's pages (M3 Step 8): a new invoice (members who prepare them: from scratch, or from an
// accepted quotation, an order or a recorded sale), one invoice as it is (with what the member may do
// with it), and a draft changed. An invoice of a branch the member does not work in is "not found"
// (Q12), as one that does not exist.

/** An invoice page on its way (also its loading.tsx). */
export function InvoiceLoading() {
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
      <Link href={`/b/${businessId}/invoices`}>
        {t('states.goTo', { section: t('common.nav.invoices') })}
      </Link>
    </Button>
  )
}

function MayNotPrepare() {
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
        title={t('documents.invoices.view.notFound')}
        body={t('documents.invoices.view.notFoundBody')}
        documentTitle={`${t('documents.invoices.view.notFound')} · ${t('appName')}`}
      >
        <BackToList />
      </StatePanel>
    </PageContainer>
  )
}

function NewInvoice() {
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!mayManageInvoices(context)) return <MayNotPrepare />
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <InvoiceLoading />
  return <InvoiceEditor today={books.data.today} startFrom={<StartFrom />} />
}

function OneInvoice({ invoiceId, edit }: { invoiceId: string; edit: boolean }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const invoice = useQuery(trpc.invoice.get.queryOptions({ id: invoiceId }))
  if (!context) return null
  if (invoice.isError && apiErrorCode(invoice.error) === 'not_found') return <NotFound />
  const error = invoice.error ?? books.error
  if (error && (!invoice.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void invoice.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!invoice.data || !books.data) return <InvoiceLoading />
  // Only a draft changes, by a member who prepares invoices; otherwise it shows as it is.
  if (edit && invoice.data.status === 'draft' && mayManageInvoices(context)) {
    return <InvoiceEditor key={invoice.data.id} invoice={invoice.data} today={books.data.today} />
  }
  return (
    <InvoiceView
      invoice={invoice.data}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
    />
  )
}

/** A new invoice, inside the module's gate. */
export function NewInvoicePage() {
  return (
    <ModuleGate moduleId="invoices" entryId="invoices">
      <NewInvoice />
    </ModuleGate>
  )
}

/** One invoice (or, `edit`, a draft changed), inside the module's gate. */
export function InvoicePage({ invoiceId, edit = false }: { invoiceId: string; edit?: boolean }) {
  return (
    <ModuleGate moduleId="invoices" entryId="invoices">
      <OneInvoice invoiceId={invoiceId} edit={edit} />
    </ModuleGate>
  )
}
