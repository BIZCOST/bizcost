'use client'

import { apiErrorCode, useTRPC } from '@bizcost/app-core'
import type { CustomerStatementDto, StatementEntryDto } from '@bizcost/contracts'
import { compareDecimal, subtractDecimals } from '@bizcost/domain'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, FileTextIcon, LockKeyholeIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { TextField } from '@/components/form/text-field'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { PdfDialog } from '@/features/quotations/pdf-dialog'
import { hasModule } from '@/features/purchasing/data'
import { useBooks } from '@/features/sales/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { maySeeStatements } from './data'
import { DAY, periodOf, PRESETS } from './period'

// A customer's statement (M3 Step 8; Q27): for a period (this month, last month, the last three
// months, this year, or any days up to two years), what was owed at its start, each invoice, order or
// sale "they'll pay later" (what was invoiced or delivered), each credit note, refund and payment on
// its day with what was owed after it, the period's sums and what is owed at its end; and the same on
// the business's letterhead as a PDF («كشف حساب · Statement of Account») to download or share. A
// sale says its first items and a payment how it was paid; an invoice of work its order or sale
// charged on an earlier day says it was "Already owed" (it adds nothing again, D-313); owed below zero
// is "Paid ahead". The period lives in the address. Since Release B every business with Customers on
// has it (B10): an orders-only one's (`invoicing` false) says "Orders and sales" and "Payments and
// refunds", never invoices or credit notes.

type StatementWord = 'invoiced' | 'credited' | 'charge' | 'credit'

/** A sum's or a column's name: the invoices' words, or an orders-only business's (`_plain`). */
function useStatementWord(invoicing: boolean) {
  const { t } = useTranslation()
  return (word: StatementWord): string =>
    invoicing
      ? t(`documents.invoices.statement.${word}`)
      : t(`documents.invoices.statement.${word}_plain`)
}

/**
 * What an entry was, under its name: a sale's first items, how a payment was paid, what of an invoice
 * was owed already through its order or sale (of a credit note, what its order still owes).
 */
function useEntryDetail(currency: string) {
  const { t } = useTranslation()
  const money = useMoney()
  return (entry: StatementEntryDto): string | null => {
    const through = entry.owedThrough
    if (through && (entry.kind === 'invoice' || entry.kind === 'credit_note')) {
      const amount = money(through.amount, currency)
      const order = through.orderNumber ?? ''
      if (entry.kind === 'credit_note') {
        return t('documents.pdf.statement.stillOwedOrder', { order, amount })
      }
      return through.orderNumber === null
        ? t('documents.pdf.statement.owedThroughSale', { amount })
        : t('documents.pdf.statement.owedThroughOrder', { order, amount })
    }
    if ((entry.kind === 'sale' || entry.kind === 'refund') && entry.itemNames.length > 0) {
      return entry.itemNames.join(t('sales.list.namesSeparator'))
    }
    if ((entry.kind === 'payment' || entry.kind === 'money_back') && entry.method) {
      return t(`purchasing.paymentMethods.${entry.method}`)
    }
    return null
  }
}

/** What is owed, or, below zero, what was paid ahead (its label and amount). */
function owedOf(value: string): { ahead: boolean; amount: string } {
  return compareDecimal(value, '0') < 0
    ? { ahead: true, amount: subtractDecimals('0', value) }
    : { ahead: false, amount: value }
}

/** An entry's name: "Invoice INV-0003", "Payment – INV-0003", "Sale". */
function useEntryName() {
  const { t } = useTranslation()
  // The entries' words isolate their numbers themselves (as the PDF prints them).
  return (entry: StatementEntryDto): string => {
    const number = entry.number ?? ''
    const reference = entry.reference ?? ''
    // A reversal of an entry of a closed day, listed on the day of the reversal (D-334).
    if (entry.reversal) {
      switch (entry.kind) {
        case 'sale':
          return t('documents.pdf.statement.saleReversed')
        case 'refund':
          return t('documents.pdf.statement.refundReversed')
        case 'payment':
          return entry.reference
            ? t('documents.pdf.statement.paymentReversedOn', { reference })
            : t('documents.pdf.statement.paymentReversed')
        case 'money_back':
          return entry.reference
            ? t('documents.pdf.statement.money_backReversedOn', { reference })
            : t('documents.pdf.statement.money_backReversed')
        default:
          break
      }
    }
    switch (entry.kind) {
      case 'invoice':
        return t('documents.pdf.statement.invoice', { number })
      case 'credit_note':
        return t('documents.pdf.statement.credit_note', { number })
      case 'order':
        return t('documents.pdf.statement.order', { number })
      case 'sale':
        return t('documents.pdf.statement.sale')
      case 'refund':
        return t('documents.pdf.statement.refund')
      case 'payment':
        return entry.paidWhenMade
          ? t('documents.pdf.statement.paidWhenMade')
          : entry.reference
            ? t('documents.pdf.statement.paymentOn', { reference })
            : t('documents.pdf.statement.payment')
      case 'money_back':
        return entry.reference
          ? t('documents.pdf.statement.money_backOn', { reference })
          : t('documents.pdf.statement.money_back')
    }
  }
}

function Sums({ statement }: { statement: CustomerStatementDto }) {
  const { t } = useTranslation()
  const money = useMoney()
  const word = useStatementWord(statement.invoicing)
  const closing = owedOf(statement.closing)
  const rows = [
    ['opening', statement.opening],
    ['invoiced', statement.invoiced],
    ['credited', statement.credited],
    ['paid', statement.paid],
    [closing.ahead ? 'closingAhead' : 'closing', closing.amount],
  ] as const
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {rows.map(([key, value]) => (
        <div
          key={key}
          data-statement-sum={key}
          className={cn(
            'rounded-xl bg-muted/50 px-3 py-2.5',
            (key === 'closing' || key === 'closingAhead') && 'col-span-2 bg-accent sm:col-span-1',
          )}
        >
          <dt className="text-xs text-muted-foreground">
            {key === 'invoiced' || key === 'credited'
              ? word(key)
              : t(`documents.invoices.statement.${key}`)}
          </dt>
          <dd
            className={cn(
              'mt-0.5 font-semibold tabular-nums',
              (key === 'closing' || key === 'closingAhead') && 'text-lg',
            )}
          >
            <bdi>{money(value, statement.currency)}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Entries({ statement }: { statement: CustomerStatementDto }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const nameOf = useEntryName()
  const detailOf = useEntryDetail(statement.currency)
  const word = useStatementWord(statement.invoicing)
  const { businessId } = useParams<{ businessId: string }>()
  const hrefOf = (entry: StatementEntryDto): string | null =>
    entry.kind === 'invoice'
      ? `/b/${businessId}/invoices/${entry.id}`
      : entry.kind === 'order'
        ? `/b/${businessId}/orders/${entry.id}`
        : entry.kind === 'sale' || entry.kind === 'refund'
          ? `/b/${businessId}/sales/${entry.id}`
          : null
  const amount = (value: string) =>
    compareDecimal(value, '0') === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <bdi className="tabular-nums">{money(value, statement.currency)}</bdi>
    )
  if (statement.entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('documents.invoices.statement.empty')}</p>
    )
  }
  const nameCell = (entry: StatementEntryDto) => {
    const href = hrefOf(entry)
    const name = nameOf(entry)
    const detail = detailOf(entry)
    // A document's number is never broken at its hyphen.
    return (
      <>
        {href ? (
          <Link
            href={href}
            className="whitespace-nowrap text-primary underline-offset-4 hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="whitespace-nowrap">{name}</span>
        )}
        {detail ? (
          <span
            data-statement-detail
            className="block text-xs font-normal break-words text-muted-foreground"
          >
            <bdi>{detail}</bdi>
          </span>
        ) : null}
      </>
    )
  }
  /** What is owed after an entry, or "Paid ahead" below zero. */
  const owedCell = (value: string, labelled: boolean) => {
    const owed = owedOf(value)
    return (
      <>
        {labelled || owed.ahead ? (
          <>
            {t(
              owed.ahead
                ? 'documents.invoices.statement.ahead'
                : 'documents.invoices.statement.owed',
            )}{' '}
          </>
        ) : null}
        <bdi className="tabular-nums">{money(owed.amount, statement.currency)}</bdi>
      </>
    )
  }
  return (
    <>
      {/* A phone: each entry on its own, its amount beside it and what is owed after it under it. */}
      <ol
        className="-my-1 divide-y sm:hidden"
        aria-label={t('documents.invoices.statement.entries')}
      >
        <li className="flex items-baseline justify-between gap-3 py-2.5 text-sm text-muted-foreground">
          <span>
            <span className="block">{t('documents.pdf.statement.openingRow')}</span>
            <span className="block text-xs">{businessDate(statement.from)}</span>
          </span>
          <bdi className="font-medium tabular-nums">
            {money(statement.opening, statement.currency)}
          </bdi>
        </li>
        {statement.entries.map((entry, index) => {
          const charge = compareDecimal(entry.charge, '0') !== 0
          // An invoice its order or sale charged already adds nothing (its detail says so).
          const nothing = !charge && compareDecimal(entry.credit, '0') === 0
          return (
            <li
              key={`${entry.kind}-${entry.id}-${index}`}
              data-statement-entry={entry.kind}
              className="py-2.5 text-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 font-medium">{nameCell(entry)}</span>
                {nothing ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <bdi className={charge ? 'tabular-nums' : 'tabular-nums text-success'}>
                    {charge
                      ? money(entry.charge, statement.currency)
                      : `−${money(entry.credit, statement.currency)}`}
                  </bdi>
                )}
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span>{businessDate(entry.date)}</span>
                <span>{owedCell(entry.owed, true)}</span>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="-mx-4 hidden overflow-x-auto sm:-mx-5 sm:block">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-start font-medium sm:ps-5">
                {t('documents.invoices.statement.date')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('documents.invoices.statement.document')}
              </th>
              <th scope="col" className="px-2 py-2 text-end font-medium">
                {word('charge')}
              </th>
              <th scope="col" className="px-2 py-2 text-end font-medium">
                {word('credit')}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium sm:pe-5">
                {t('documents.invoices.statement.owed')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="text-muted-foreground">
              <td className="px-4 py-2.5 whitespace-nowrap sm:ps-5">
                {businessDate(statement.from)}
              </td>
              <td className="px-2 py-2.5" colSpan={3}>
                {t('documents.pdf.statement.openingRow')}
              </td>
              <td className="px-4 py-2.5 text-end font-medium sm:pe-5">
                <bdi className="tabular-nums">{money(statement.opening, statement.currency)}</bdi>
              </td>
            </tr>
            {statement.entries.map((entry, index) => {
              return (
                <tr key={`${entry.kind}-${entry.id}-${index}`} data-statement-entry={entry.kind}>
                  <td className="px-4 py-2.5 whitespace-nowrap sm:ps-5">
                    {businessDate(entry.date)}
                  </td>
                  <td className="px-2 py-2.5">{nameCell(entry)}</td>
                  <td className="px-2 py-2.5 text-end">{amount(entry.charge)}</td>
                  <td className="px-2 py-2.5 text-end">{amount(entry.credit)}</td>
                  <td className="px-4 py-2.5 text-end font-medium sm:pe-5">
                    {owedCell(entry.owed, false)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Statement({
  customerId,
  today,
  invoicesOn,
}: {
  customerId: string
  today: string
  /** Invoices is on: the intro's words until the statement says (`invoicing`). */
  invoicesOn: boolean
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { businessId } = useParams<{ businessId: string }>()
  const customer = useQuery(trpc.customer.get.queryOptions({ id: customerId }))
  const pdf = useMutation(trpc.customer.statementPdf.mutationOptions())
  const [pdfOpen, setPdfOpen] = useState(false)
  const fallback = periodOf('thisMonth', today)
  const fromParam = params.get('from') ?? ''
  const toParam = params.get('to') ?? ''
  const period = {
    from: DAY.test(fromParam) ? fromParam : fallback.from,
    to: DAY.test(toParam) ? toParam : fallback.to,
  }
  const [from, setFrom] = useState(period.from)
  const [to, setTo] = useState(period.to)
  const statement = useQuery({
    ...trpc.customer.statement.queryOptions({ customerId, ...period }),
    retry: false,
  })
  const preset = PRESETS.find((p) => {
    const span = periodOf(p, today)
    return span.from === period.from && span.to === period.to
  })
  const show = (next: { from: string; to: string }) => {
    setFrom(next.from)
    setTo(next.to)
    const query = new URLSearchParams(params.toString())
    query.set('from', next.from)
    query.set('to', next.to)
    router.replace(`${pathname}?${query.toString()}`, { scroll: false })
  }
  const customerHref = `/b/${businessId}/customers/${customerId}`
  if (customer.isError && apiErrorCode(customer.error) === 'not_found') {
    return (
      <PageContainer>
        <StatePanel
          icon={SearchXIcon}
          title={t('orders.customers.page.notFound')}
          body={t('orders.customers.page.notFoundBody')}
          documentTitle={`${t('orders.customers.page.notFound')} · ${t('appName')}`}
        />
      </PageContainer>
    )
  }
  const name = customer.data?.name ?? statement.data?.customer.name ?? ''
  const periodError =
    statement.isError && apiErrorCode(statement.error) === 'validation'
      ? t('documents.invoices.statement.periodError')
      : null

  return (
    <PageContainer>
      <Link
        href={customerHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {name ? <bdi>{name}</bdi> : t('common.nav.customers')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">
            {t('documents.invoices.statement.title', { name: isolate(name) })}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {(statement.data?.invoicing ?? invoicesOn)
              ? t('documents.invoices.statement.intro')
              : t('documents.invoices.statement.intro_plain')}
          </p>
        </div>
        <Button data-statement-pdf disabled={!statement.data} onClick={() => setPdfOpen(true)}>
          <FileTextIcon aria-hidden />
          {t('documents.invoices.statement.pdf')}
        </Button>
      </header>

      <div className="space-y-5">
        <Panel title={t('documents.invoices.statement.period')}>
          <div className="space-y-4">
            <div className="min-w-0">
              <div
                className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-flex"
                role="group"
              >
                {PRESETS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={preset === value}
                    data-statement-preset={value}
                    onClick={() => show(periodOf(value, today))}
                    className={cn(
                      'flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
                      preset === value && 'bg-card text-foreground shadow-sm',
                    )}
                  >
                    {t(`documents.invoices.statement.presets.${value}`)}
                  </button>
                ))}
              </div>
            </div>
            <form
              className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={(event) => {
                event.preventDefault()
                if (DAY.test(from) && DAY.test(to)) show({ from, to })
              }}
            >
              <TextField
                label={t('documents.invoices.statement.from')}
                type="date"
                max={to || today}
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <TextField
                label={t('documents.invoices.statement.to')}
                type="date"
                min={from || undefined}
                max={today}
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
              <Button type="submit" variant="outline" className="col-span-2 sm:col-span-1">
                {t('documents.invoices.statement.show')}
              </Button>
            </form>
            {periodError ? (
              <p role="alert" className="text-sm text-destructive">
                {periodError}
              </p>
            ) : null}
          </div>
        </Panel>

        {statement.isPending ? (
          <SectionSkeleton cards={2} />
        ) : statement.isError ? (
          periodError ? null : (
            <LoadError error={statement.error} onRetry={() => void statement.refetch()} />
          )
        ) : (
          <>
            <Sums statement={statement.data} />
            <Panel title={t('documents.invoices.statement.entries')}>
              <Entries statement={statement.data} />
            </Panel>
          </>
        )}
      </div>
      <PdfDialog
        open={pdfOpen}
        title={t('documents.invoices.statement.pdfTitle')}
        description={t('documents.invoices.statement.pdfNote')}
        shareTitle={t('documents.invoices.statement.title', { name })}
        remake={`${customerId}:${period.from}:${period.to}`}
        make={() => pdf.mutateAsync({ customerId, ...period })}
        onClose={() => setPdfOpen(false)}
      />
    </PageContainer>
  )
}

function StatementGate({ customerId }: { customerId: string }) {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!maySeeStatements(context)) {
    return (
      <PageContainer>
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('states.forbidden.title')}
          body={t('states.forbidden.body')}
          documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
        />
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
  if (!books.data) {
    return (
      <PageContainer>
        <SectionSkeleton cards={3} />
      </PageContainer>
    )
  }
  return (
    <Statement
      customerId={customerId}
      today={books.data.today}
      invoicesOn={hasModule(context, 'invoices')}
    />
  )
}

/** A customer's statement, inside the Customers module's gate. */
export function StatementPage({ customerId }: { customerId: string }) {
  return (
    <ModuleGate moduleId="customers" entryId="customers">
      <StatementGate customerId={customerId} />
    </ModuleGate>
  )
}
