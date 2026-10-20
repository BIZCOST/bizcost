'use client'

import { useTRPC } from '@bizcost/app-core'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { PlusIcon, ReceiptTextIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { SearchBox } from '@/features/documents/search-box'
import { maySeePayments } from '@/features/orders/data'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { mayManageInvoices } from './data'
import { DepositsWithoutInvoice } from './deposits'
import { InvoiceRow } from './invoice-row'

// Invoices (M3 Step 8; Q22, Q25–Q27): drafts first (no number yet), then issued invoices by number,
// newest first, each with its customer, what it bills, its LPO and the order or quotation it comes
// from, its amount and its state (draft, issued, owed, part paid, paid, overdue after its due date,
// credited, and "Partly credited" beside it). The filter and the search (a number, an LPO or the
// customer's name) live in the address. A VAT-registered business sees, above them, each deposit
// recorded without its tax invoice, with its 14-day deadline (M6).

const FILTERS = ['all', 'draft', 'issued', 'owed', 'overdue', 'credited'] as const
type Filter = (typeof FILTERS)[number]
/** What only a member who sees payments can filter by (the API refuses it otherwise). */
const PAYMENT_FILTERS: ReadonlySet<Filter> = new Set(['owed', 'overdue'])

function useFilters(allowed: readonly Filter[]) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const statusParam = params.get('status')
  const status: Filter = (allowed as readonly (string | null)[]).includes(statusParam)
    ? (statusParam as Filter)
    : 'all'
  const search = (params.get('q') ?? '').trim()
  const set = (next: { status?: Filter; search?: string }) => {
    const query = new URLSearchParams(params.toString())
    if (next.status !== undefined) {
      if (next.status === 'all') query.delete('status')
      else query.set('status', next.status)
    }
    if (next.search !== undefined) {
      if (next.search.trim()) query.set('q', next.search.trim())
      else query.delete('q')
    }
    const text = query.toString()
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
  }
  return { status, search, set }
}

function InvoicesList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const seesPayments = context !== undefined && maySeePayments(context)
  const allowed = FILTERS.filter((filter) => seesPayments || !PAYMENT_FILTERS.has(filter))
  const { status, search, set } = useFilters(allowed)
  const list = useInfiniteQuery(
    trpc.invoice.list.infiniteQueryOptions(
      { status, search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  if (!context) return null
  const canManage = mayManageInvoices(context)
  const profile = context.terminologyProfile
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const filtered = status !== 'all' || search !== ''
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/invoices`

  const newButton = canManage ? (
    <Button asChild size="lg">
      <Link href={`${base}/new`}>
        <PlusIcon aria-hidden />
        {t('documents.invoices.list.new')}
      </Link>
    </Button>
  ) : null

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('common.nav.invoices')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {term('documents.invoices.list.intro', profile)}
          </p>
        </div>
        {firstTime ? null : newButton}
      </header>
      <DepositsWithoutInvoice />
      {firstTime ? null : (
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchBox
            value={search}
            placeholder={t('documents.invoices.list.searchPlaceholder')}
            onChange={(next) => set({ search: next })}
          />
          {/* A fieldset is never narrower than its content unless told so (min-w-0): on a phone
              the filters scroll sideways inside it instead of widening the page. */}
          <fieldset className="-mx-1 flex min-w-0 shrink-0 overflow-x-auto px-1 pb-1 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0">
            <legend className="sr-only">{t('documents.invoices.list.statusLabel')}</legend>
            <div className="flex min-w-full rounded-lg bg-muted p-1">
              {allowed.map((value) => (
                <label key={value} className="relative flex-1 lg:flex-none">
                  <input
                    type="radio"
                    name="invoice-status"
                    value={value}
                    checked={status === value}
                    onChange={() => set({ status: value })}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      'flex h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
                      'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                      'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                      'after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
                    )}
                  >
                    {t(`documents.invoices.list.filters.${value}`)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('documents.invoices.list.noMatches')}
            body={t('documents.invoices.list.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={ReceiptTextIcon}
            title={t('documents.invoices.list.empty.title')}
            body={
              canManage
                ? term('documents.invoices.list.empty.body', profile)
                : t('documents.invoices.list.empty.viewer')
            }
          >
            {newButton}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-5">
          <ul
            aria-label={t('common.nav.invoices')}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((invoice) => (
              <li key={invoice.id}>
                <InvoiceRow invoice={invoice} href={`${base}/${invoice.id}`} />
              </li>
            ))}
          </ul>
          {list.isError ? (
            <LoadError error={list.error} onRetry={() => void list.fetchNextPage()} />
          ) : list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? t('status.loading') : t('catalog.list.showMore')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageContainer>
  )
}

/** The Invoices page: the list inside the module's gate. */
export function InvoicesPage() {
  return (
    <ModuleGate moduleId="invoices" entryId="invoices">
      <InvoicesList />
    </ModuleGate>
  )
}
