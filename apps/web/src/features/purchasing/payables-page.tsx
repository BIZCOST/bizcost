'use client'

import { useTRPC } from '@bizcost/app-core'
import type {
  PayableGroupDto,
  PayableInvoiceDto,
  PayablePartyDto,
  PurchasePaymentsDto,
} from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { formatList } from '@bizcost/i18n'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { HandCoinsIcon, LockKeyholeIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { Money, useBusinessDate } from './amounts'
import { PaymentSheet } from './payment-sheet'

// Amounts owed (the owner's request of 2026-09-29; the Purchases module's second nav entry, with
// purchases.payments.view): what the business still owes, in two tabs, "To suppliers" (purchases
// bought on credit, by supplier) and "To employees" (purchases a member paid from their own money, by
// member). Each purchase says its day, its total, what its returns and credit notes took off (when
// any), what was paid, what is still owed and who entered it, opens at its page, and with
// purchases.payments.record takes a payment ("Record a payment"). The amounts are supplier prices: a
// member who may not see them is told so (payable.list refuses). payable.list comes a page of
// suppliers or members at a time ("Show more"), each with its oldest purchases still owed.

const TABS: readonly { party: PayablePartyDto; param: string | null }[] = [
  { party: 'supplier', param: null },
  { party: 'member', param: 'employees' },
]

function useParty(): [PayablePartyDto, (party: PayablePartyDto) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const party: PayablePartyDto = params.get('to') === 'employees' ? 'member' : 'supplier'
  return [
    party,
    (next) =>
      router.replace(next === 'member' ? `${pathname}?to=employees` : pathname, { scroll: false }),
  ]
}

/** One purchase still owed: its day and number, first items, amounts, who entered it. */
function InvoiceRow({
  invoice,
  href,
  onPay,
}: {
  invoice: PayableInvoiceDto
  href: string
  /** Absent: the member may not record payments. */
  onPay?: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const businessDate = useBusinessDate()
  const items = formatList(
    locale,
    invoice.itemNames.filter(Boolean).map((name) => isolate(name)),
  )
  // Returns and credit notes took something off: said, so that the amounts add up.
  const returned = invoice.returned !== undefined && compareDecimal(invoice.returned, '0') > 0
  return (
    <li
      data-invoice
      className="grid gap-x-4 gap-y-2 px-4 py-3 sm:px-5 xl:grid-cols-[minmax(0,1fr)_repeat(4,8.5rem)_auto] xl:items-center"
    >
      <div className="min-w-0">
        <Link
          href={href}
          className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
        >
          {t('purchasing.view.title', { date: businessDate(invoice.businessDate) })}
        </Link>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {invoice.reference ? (
            <>
              <bdi dir="auto">{invoice.reference}</bdi>
              {items ? ' · ' : null}
            </>
          ) : null}
          {items}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {invoice.enteredBy.name
            ? t('purchasing.payables.enteredBy', { name: isolate(invoice.enteredBy.name) })
            : t('purchasing.payables.enteredByFormer')}
        </p>
      </div>
      <dl
        className={cn(
          'grid gap-2 text-sm xl:contents',
          returned ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
        )}
      >
        <div data-amount="total" className="min-w-0 xl:text-end">
          <dt className="text-xs text-muted-foreground">{t('purchasing.payments.total')}</dt>
          <dd>
            <Money value={invoice.total} currency={invoice.currency} />
          </dd>
        </div>
        {returned ? (
          <div data-amount="returned" className="min-w-0 xl:text-end">
            <dt className="text-xs text-muted-foreground">{t('purchasing.payments.returned')}</dt>
            <dd>
              <Money value={invoice.returned} currency={invoice.currency} />
            </dd>
          </div>
        ) : null}
        {/* On a wide screen, the columns stay lined up without returns too. */}
        <div
          data-amount="paid"
          className={cn('min-w-0 xl:text-end', !returned && 'xl:col-start-4')}
        >
          <dt className="text-xs text-muted-foreground">{t('purchasing.payments.paid')}</dt>
          <dd>
            <Money value={invoice.paid} currency={invoice.currency} />
          </dd>
        </div>
        <div data-amount="outstanding" className="min-w-0 xl:text-end">
          <dt className="text-xs text-muted-foreground">{t('purchasing.payments.outstanding')}</dt>
          <dd className="font-semibold">
            <Money value={invoice.outstanding} currency={invoice.currency} />
          </dd>
        </div>
      </dl>
      {onPay ? (
        <Button
          variant="outline"
          className="justify-self-start xl:justify-self-end"
          onClick={onPay}
        >
          <HandCoinsIcon aria-hidden />
          {t('purchasing.payments.record')}
        </Button>
      ) : null}
    </li>
  )
}

/** A supplier or member and the purchases still owed to them. */
function GroupCard({
  group,
  businessId,
  onPay,
}: {
  group: PayableGroupDto
  businessId: string
  onPay?: (invoice: PayableInvoiceDto) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <section
      data-payable-group
      aria-labelledby={id}
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b bg-muted/30 px-4 py-3 sm:px-5">
        <h2 id={id} className="flex min-w-0 flex-wrap items-center gap-2 font-semibold">
          <bdi className="min-w-0 [overflow-wrap:anywhere]">{group.name}</bdi>
          {group.active ? null : (
            <Badge tone="neutral">
              {group.party === 'supplier'
                ? t('purchasing.payables.archived')
                : t('purchasing.payables.left')}
            </Badge>
          )}
        </h2>
        <p className="text-sm">
          <span className="text-muted-foreground">
            {t('purchasing.payables.invoices', { count: group.invoiceCount })}
            {' · '}
          </span>
          <span data-group-outstanding className="font-semibold">
            <Money value={group.outstanding} />
          </span>
        </p>
      </div>
      <ul aria-label={group.name} className="divide-y">
        {group.invoices.map((invoice) => (
          <InvoiceRow
            key={invoice.purchaseId}
            invoice={invoice}
            href={`/b/${businessId}/purchases/${invoice.purchaseId}`}
            onPay={onPay ? () => onPay(invoice) : undefined}
          />
        ))}
      </ul>
      {group.invoiceCount > group.invoices.length ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-5">
          {t('purchasing.payables.moreInvoices', {
            shown: group.invoices.length,
            count: group.invoiceCount,
          })}
        </p>
      ) : null}
    </section>
  )
}

function Payables() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const [party, setParty] = useParty()
  const seesAmounts = context?.visibleCategories.includes('supplier_price') === true
  const list = useInfiniteQuery(
    trpc.payable.list.infiniteQueryOptions(
      { party },
      { getNextPageParam: (page) => page.data.nextCursor, enabled: seesAmounts },
    ),
  )
  const books = useQuery(trpc.books.get.queryOptions())
  const [paying, setPaying] = useState<{
    owed: PurchasePaymentsDto['data']
    purchaseDate: string
  } | null>(null)
  const tabsId = useId()
  if (!context) return null
  const canRecord = can(context, 'purchases.payments.record') && seesAmounts
  const title = t('common.nav.payables')
  const first = list.data?.pages[0]?.data
  const groups = list.data?.pages.flatMap((page) => page.data.groups) ?? []

  function pay(group: PayableGroupDto, invoice: PayableInvoiceDto) {
    setPaying({
      purchaseDate: invoice.businessDate,
      owed: {
        purchaseId: invoice.purchaseId,
        owedTo: { party: group.party, partyId: group.partyId, name: group.name },
        status: 'posted',
        currency: invoice.currency,
        total: invoice.total,
        returned: invoice.returned,
        paid: invoice.paid,
        outstanding: invoice.outstanding,
        overpaid: '0',
        payments: [],
      },
    })
  }

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">{t('purchasing.payables.intro')}</p>
      </header>
      <div
        role="tablist"
        aria-label={title}
        className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-grid sm:min-w-96"
      >
        {TABS.map((tab) => (
          <button
            key={tab.party}
            type="button"
            role="tab"
            id={`${tabsId}-${tab.party}`}
            aria-selected={party === tab.party}
            aria-controls={`${tabsId}-panel`}
            onClick={() => setParty(tab.party)}
            className={cn(
              'flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
              party === tab.party && 'bg-card text-foreground shadow-sm',
            )}
          >
            {tab.party === 'supplier'
              ? t('purchasing.payables.toSuppliers')
              : t('purchasing.payables.toEmployees')}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${party}`}
        className="space-y-4"
      >
        {!seesAmounts ? (
          <ListEmpty
            icon={LockKeyholeIcon}
            title={t('purchasing.payables.lockedTitle')}
            body={t('purchasing.payables.locked')}
          />
        ) : list.isPending ? (
          <ListSkeleton />
        ) : list.isError && !first ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : !first || groups.length === 0 ? (
          <ListEmpty
            icon={HandCoinsIcon}
            title={
              party === 'supplier'
                ? t('purchasing.payables.emptySuppliers')
                : t('purchasing.payables.emptyEmployees')
            }
            body={
              party === 'supplier'
                ? t('purchasing.payables.emptySuppliersBody')
                : t('purchasing.payables.emptyEmployeesBody')
            }
          />
        ) : (
          <>
            <p
              data-payables-total
              className="flex items-baseline justify-between gap-3 rounded-2xl bg-card px-4 py-3 text-base font-semibold shadow-sm ring-1 ring-foreground/[0.06] sm:px-5"
            >
              <span>
                {party === 'supplier'
                  ? t('purchasing.payables.totalSuppliers')
                  : t('purchasing.payables.totalEmployees')}
              </span>
              <Money value={first.total} currency={first.currency} />
            </p>
            {groups.map((group) => (
              <GroupCard
                key={group.partyId}
                group={group}
                businessId={businessId}
                onPay={canRecord ? (invoice) => pay(group, invoice) : undefined}
              />
            ))}
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
          </>
        )}
      </div>
      {paying && books.data ? (
        <PaymentSheet
          owed={paying.owed}
          purchaseDate={paying.purchaseDate}
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </PageContainer>
  )
}

/** Amounts owed, inside the Purchases module's gate (its "payables" entry). */
export function PayablesPage() {
  return (
    <ModuleGate moduleId="purchases" entryId="payables">
      <Payables />
    </ModuleGate>
  )
}
