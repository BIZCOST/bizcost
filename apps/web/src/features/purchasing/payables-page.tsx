'use client'

import { useTRPC } from '@bizcost/app-core'
import type {
  PayableGroupDto,
  PayableInvoiceDto,
  PayableKindDto,
  PayablePartyDto,
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
import { mayListPayables } from './data'
import { OwedToMeList } from './owed-to-me'
import { PaymentSheet, type OwedAmounts, type OwedDocument } from './payment-sheet'

// Amounts owed (the owner's request of 2026-09-29; a nav entry of Purchases and of Expenses, listed
// once, D-166): what the business still owes, in two tabs, "To suppliers" (purchases and expenses on
// credit, by supplier) and "To employees" (purchases and expenses a member paid from their own money,
// by member). Each says its day, its total, what its returns and credit notes took off (a purchase,
// when any), what was paid, what is still owed and who entered it, opens at its page, and with the
// key to record payments of its kind (purchases.payments.record, expenses.payments.record) takes a
// payment ("Record a payment"). A member sees the kinds whose payments they may see (payable.list).
// The amounts are supplier prices: a member who may not see them is told so (payable.list refuses).
// payable.list comes a page of suppliers or members at a time ("Show more"), each with its oldest
// purchases and expenses still owed. A third tab, "Owed to me" (the owner's answers of 2026-09-29,
// D-181), lists what the business owes the member for what they paid themselves and what it paid
// them back; the page is open to every member while Purchases or Expenses is on, and a member who
// may not list what is owed to others sees only that.

/** The modules whose documents are owed here: the page is open through either (D-166). */
const PAYABLES_MODULES = ['purchases', 'expenses'] as const

/** A tab: to suppliers, to employees, or to the member themselves. */
type PayablesTab = PayablePartyDto | 'me'

const TABS: readonly { tab: PayablesTab; param: string | null }[] = [
  { tab: 'supplier', param: null },
  { tab: 'member', param: 'employees' },
  { tab: 'me', param: 'me' },
]

/** The tab in the address (`?to=employees`, `?to=me`); only "Owed to me" without the list. */
function useTab(canList: boolean): [PayablesTab, (tab: PayablesTab) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const to = params.get('to')
  const tab: PayablesTab = !canList
    ? 'me'
    : (TABS.find((entry) => entry.param !== null && entry.param === to)?.tab ?? 'supplier')
  return [
    tab,
    (next) => {
      const param = TABS.find((entry) => entry.tab === next)?.param
      router.replace(param ? `${pathname}?to=${param}` : pathname, { scroll: false })
    },
  ]
}

/**
 * One purchase or expense still owed: its day and number, a purchase's first items or an expense's
 * category and what it was for, the amounts, who entered it.
 */
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
  // A purchase: its first items ("Milk and Sugar"); an expense: its category · what it was for.
  const items =
    invoice.kind === 'expense'
      ? [invoice.categoryName, ...invoice.itemNames]
          .filter((name): name is string => Boolean(name))
          .map((name) => isolate(name))
          .join(' · ')
      : formatList(
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
          {t(
            invoice.kind === 'expense'
              ? 'purchasing.payables.expenseTitle'
              : 'purchasing.view.title',
            { date: businessDate(invoice.businessDate) },
          )}
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

/** A supplier or member and the purchases and expenses still owed to them. */
function GroupCard({
  group,
  businessId,
  onPay,
}: {
  group: PayableGroupDto
  businessId: string
  /** Absent for a kind the member may not record payments of. */
  onPay?: (invoice: PayableInvoiceDto) => (() => void) | undefined
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
            key={`${invoice.kind}:${invoice.documentId}`}
            invoice={invoice}
            href={`/b/${businessId}/${invoice.kind === 'expense' ? 'expenses' : 'purchases'}/${invoice.documentId}`}
            onPay={onPay?.(invoice)}
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
  // What is owed to others needs its keys (and supplier prices, or its tabs say they are hidden);
  // anyone else sees only "Owed to me".
  const canList = context !== undefined && mayListPayables(context)
  const [tab, setTab] = useTab(canList)
  const party: PayablePartyDto = tab === 'member' ? 'member' : 'supplier'
  const seesAmounts = context?.visibleCategories.includes('supplier_price') === true
  const list = useInfiniteQuery(
    trpc.payable.list.infiniteQueryOptions(
      { party },
      {
        getNextPageParam: (page) => page.data.nextCursor,
        enabled: seesAmounts && canList && tab !== 'me',
      },
    ),
  )
  const books = useQuery(trpc.books.get.queryOptions())
  const [paying, setPaying] = useState<{ document: OwedDocument; owed: OwedAmounts } | null>(null)
  const tabsId = useId()
  if (!context) return null
  // Each kind's payments are recorded with its own key (D-166), and only by a member who sees the
  // amounts.
  const canRecord: Record<PayableKindDto, boolean> = {
    purchase: seesAmounts && can(context, 'purchases.payments.record'),
    expense: seesAmounts && can(context, 'expenses.payments.record'),
  }
  const title = t('common.nav.payables')
  const first = list.data?.pages[0]?.data
  const groups = list.data?.pages.flatMap((page) => page.data.groups) ?? []

  function pay(group: PayableGroupDto, invoice: PayableInvoiceDto) {
    setPaying({
      document: { kind: invoice.kind, id: invoice.documentId, businessDate: invoice.businessDate },
      owed: {
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
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {canList ? t('purchasing.payables.intro') : t('purchasing.payables.mine.intro')}
        </p>
      </header>
      {canList ? (
        <div
          role="tablist"
          aria-label={title}
          className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 sm:inline-grid sm:min-w-[32rem]"
        >
          {TABS.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              id={`${tabsId}-${entry.tab}`}
              aria-selected={tab === entry.tab}
              aria-controls={`${tabsId}-panel`}
              onClick={() => setTab(entry.tab)}
              className={cn(
                'flex min-h-11 items-center justify-center rounded-md px-2 text-center text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
                tab === entry.tab && 'bg-card text-foreground shadow-sm',
              )}
            >
              {entry.tab === 'supplier'
                ? t('purchasing.payables.toSuppliers')
                : entry.tab === 'member'
                  ? t('purchasing.payables.toEmployees')
                  : t('purchasing.payables.toMe')}
            </button>
          ))}
        </div>
      ) : null}
      <div
        role={canList ? 'tabpanel' : undefined}
        id={`${tabsId}-panel`}
        aria-labelledby={canList ? `${tabsId}-${tab}` : undefined}
        className="space-y-4"
      >
        {tab === 'me' ? (
          <OwedToMeList />
        ) : !seesAmounts ? (
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
                onPay={(invoice) =>
                  canRecord[invoice.kind] ? () => pay(group, invoice) : undefined
                }
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
          document={paying.document}
          owed={paying.owed}
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </PageContainer>
  )
}

/**
 * Amounts owed, inside the gate of the modules that share it (Purchases, Expenses; D-166): open to
 * every member while either is on, since each sees at least what is owed to them (D-181).
 */
export function PayablesPage() {
  return (
    <ModuleGate moduleId={PAYABLES_MODULES} entryId="payables" openToEveryMember>
      <Payables />
    </ModuleGate>
  )
}
