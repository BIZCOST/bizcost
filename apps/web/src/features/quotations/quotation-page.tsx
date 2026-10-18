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
import { mayManageQuotations } from './data'
import { QuotationEditor } from './quotation-editor'
import { QuotationView } from './quotation-view'

// A quotation's pages (M3 Step 7): a new quotation (members who prepare them), one revision as it is
// (with what the member may do with it), and a draft changed. A quotation of a branch the member does
// not work in is "not found" (Q12), as one that does not exist.

/** A quotation page on its way (also its loading.tsx). */
export function QuotationLoading() {
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
      <Link href={`/b/${businessId}/quotations`}>
        {t('states.goTo', { section: t('common.nav.quotations') })}
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
        title={t('documents.quotations.view.notFound')}
        body={t('documents.quotations.view.notFoundBody')}
        documentTitle={`${t('documents.quotations.view.notFound')} · ${t('appName')}`}
      >
        <BackToList />
      </StatePanel>
    </PageContainer>
  )
}

function NewQuotation() {
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!mayManageQuotations(context)) return <MayNotPrepare />
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <QuotationLoading />
  return <QuotationEditor today={books.data.today} />
}

function OneQuotation({ quotationId, edit }: { quotationId: string; edit: boolean }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const quotation = useQuery(trpc.quotation.get.queryOptions({ id: quotationId }))
  if (!context) return null
  if (quotation.isError && apiErrorCode(quotation.error) === 'not_found') return <NotFound />
  const error = quotation.error ?? books.error
  if (error && (!quotation.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void quotation.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!quotation.data || !books.data) return <QuotationLoading />
  // Only a draft changes, by a member who prepares quotations; otherwise it shows as it is.
  if (edit && quotation.data.status === 'draft' && mayManageQuotations(context)) {
    return (
      <QuotationEditor
        key={quotation.data.id}
        quotation={quotation.data}
        today={books.data.today}
      />
    )
  }
  return <QuotationView quotation={quotation.data} today={books.data.today} />
}

/** A new quotation, inside the module's gate. */
export function NewQuotationPage() {
  return (
    <ModuleGate moduleId="quotations" entryId="quotations">
      <NewQuotation />
    </ModuleGate>
  )
}

/** One quotation (or, `edit`, a draft changed), inside the module's gate. */
export function QuotationPage({
  quotationId,
  edit = false,
}: {
  quotationId: string
  edit?: boolean
}) {
  return (
    <ModuleGate moduleId="quotations" entryId="quotations">
      <OneQuotation quotationId={quotationId} edit={edit} />
    </ModuleGate>
  )
}
