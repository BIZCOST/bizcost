'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardListIcon, FileTextIcon, ReceiptIcon } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { SearchBox } from '@/features/documents/search-box'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { BillDialog, type BillSource } from './bill-dialog'
import { useRefreshInvoices } from './data'

// A new invoice from something already there (M3 Step 8; Q3, Q22): an accepted quotation (everything,
// a stage, a part or a deposit), an order (everything, a deposit, the rest) or a One sale recorded with
// its customer (it counts already: the invoice bills it as it was). Each is picked from a short list
// with a search; a quotation or an order then asks what the invoice bills.

type SourceKind = 'quotation' | 'order' | 'sale'

/** What the member may invoice from, with its module on and its documents seen. */
export function invoiceSourcesOf(context: BusinessContextDto): SourceKind[] {
  const kinds: SourceKind[] = []
  if (hasModule(context, 'quotations') && can(context, 'quotations.documents.view')) {
    kinds.push('quotation')
  }
  if (
    hasModule(context, 'orders') &&
    (can(context, 'orders.documents.view') || can(context, 'orders.documents.manage'))
  ) {
    kinds.push('order')
  }
  if (hasModule(context, 'sales') && can(context, 'sales.documents.view')) kinds.push('sale')
  return kinds
}

const ICONS = { quotation: FileTextIcon, order: ClipboardListIcon, sale: ReceiptIcon } as const

/** The choices: "From an accepted quotation", "From an order", "From a sale you recorded". */
export function StartFrom() {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const [picking, setPicking] = useState<SourceKind | null>(null)
  if (!context) return null
  const kinds = invoiceSourcesOf(context)
  if (kinds.length === 0) return null
  return (
    <section
      aria-labelledby="invoice-start-from"
      className="mb-6 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5"
    >
      <h2 id="invoice-start-from" className="font-semibold">
        {t('documents.invoices.start.title')}
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{t('documents.invoices.start.intro')}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {kinds.map((kind) => {
          const Icon = ICONS[kind]
          return (
            <button
              key={kind}
              type="button"
              data-start-from={kind}
              onClick={() => setPicking(kind)}
              className="flex items-start gap-3 rounded-xl border bg-background/60 p-3 text-start transition-colors outline-none hover:border-primary/60 hover:bg-primary/[0.03] focus-visible:ring-3 focus-visible:ring-ring"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
                <Icon aria-hidden className="size-4.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t(`documents.invoices.start.${kind}`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`documents.invoices.start.${kind}Hint`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {picking ? <SourcePicker kind={picking} onClose={() => setPicking(null)} /> : null}
    </section>
  )
}

interface Candidate {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly amount: string
  readonly currency: string
  readonly bill?: BillSource
}

function useCandidates(kind: SourceKind, search: string) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const businessDate = useBusinessDate()
  const quotations = useQuery({
    ...trpc.quotation.list.queryOptions({ status: 'accepted', search: search || undefined }),
    enabled: kind === 'quotation',
  })
  const orders = useQuery({
    ...trpc.order.list.queryOptions({ status: 'all', search: search || undefined, limit: 30 }),
    enabled: kind === 'order',
  })
  const sales = useQuery({
    ...trpc.sale.list.queryOptions({
      source: 'single',
      status: 'posted',
      search: search || undefined,
      limit: 30,
    }),
    enabled: kind === 'sale',
  })
  const query = kind === 'quotation' ? quotations : kind === 'order' ? orders : sales
  let items: Candidate[]
  if (kind === 'quotation') {
    items = (quotations.data?.items ?? [])
      // One that became an order is invoiced from its order.
      .filter((q) => q.orderId === null)
      .map((q) => ({
        id: q.id,
        title: `${q.number} · ${q.customerName}`,
        detail: q.lineTitles.join(t('sales.list.namesSeparator')),
        amount: q.payable,
        currency: q.currency,
      }))
  } else if (kind === 'order') {
    items = (orders.data?.items ?? [])
      .filter((o) => o.status !== 'cancelled' && o.customerId !== null)
      .map((o) => ({
        id: o.id,
        title: `${o.number} · ${o.customerName ?? ''}`,
        detail: [
          o.itemNames.join(t('sales.list.namesSeparator')),
          o.customerRef ? t('documents.invoices.list.lpo', { lpo: isolate(o.customerRef) }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        amount: o.total,
        currency: o.currency,
        bill: {
          kind: 'order',
          id: o.id,
          number: o.number,
          payable: o.total,
          currency: o.currency,
          stages: [],
        },
      }))
  } else {
    items = (sales.data?.items ?? [])
      .filter((s) => s.customerName !== null && s.refundOfId === null)
      .map((s) => ({
        id: s.id,
        title: `${businessDate(s.businessDate)} · ${s.customerName ?? ''}`,
        detail: s.itemNames.join(t('sales.list.namesSeparator')),
        amount: s.total,
        currency: s.currency,
      }))
  }
  return { items, query }
}

function SourcePicker({ kind, onClose }: { kind: SourceKind; onClose: () => void }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [bill, setBill] = useState<BillSource | null>(null)
  const [sale, setSale] = useState<Candidate | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const { items, query } = useCandidates(kind, search)

  async function pick(candidate: Candidate) {
    setError(null)
    if (kind === 'sale') {
      setSale(candidate)
      return
    }
    if (candidate.bill) {
      setBill(candidate.bill)
      return
    }
    try {
      const quotation = await queryClient.fetchQuery(
        trpc.quotation.get.queryOptions({ id: candidate.id }),
      )
      setBill({
        kind: 'quotation',
        id: quotation.id,
        number: quotation.number,
        payable: quotation.payable,
        currency: quotation.currency,
        stages: quotation.stages.map((stage) => ({
          label: stage.label,
          percent: stage.percent,
          amount: stage.amount,
        })),
      })
    } catch (caught) {
      setError(apiErrorKey(caught))
    }
  }

  if (bill) return <BillDialog source={bill} onClose={onClose} />
  if (sale) {
    return (
      <InvoiceSaleDialog
        saleId={sale.id}
        label={sale.title}
        amount={money(sale.amount, sale.currency)}
        onClose={onClose}
      />
    )
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{t(`documents.invoices.start.${kind}`)}</DialogTitle>
          <DialogDescription>{t(`documents.invoices.start.${kind}Pick`)}</DialogDescription>
        </DialogHeader>
        <SearchBox
          value={search}
          placeholder={t(`documents.invoices.start.${kind}Search`)}
          onChange={setSearch}
        />
        {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {query.isPending ? (
            <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(`documents.invoices.start.${kind}None`)}
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {items.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    data-source-candidate
                    onClick={() => void pick(candidate)}
                    className="flex w-full items-start justify-between gap-3 p-3 text-start transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium break-words">
                        <bdi>{candidate.title}</bdi>
                      </span>
                      {candidate.detail ? (
                        <span className="block text-sm text-muted-foreground">
                          <bdi>{candidate.detail}</bdi>
                        </span>
                      ) : null}
                    </span>
                    <bdi className="shrink-0 text-sm font-medium tabular-nums">
                      {money(candidate.amount, candidate.currency)}
                    </bdi>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** "Invoice this sale" on a One sale's page: the confirmation, then its draft opens. */
export function InvoiceSaleDialog({
  saleId,
  label,
  amount,
  onClose,
}: {
  saleId: string
  /** "Sale of 8 Oct 2026 · Brand identity". */
  label: string
  amount: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const refresh = useRefreshInvoices()
  const { businessId } = useParams<{ businessId: string }>()
  const fromSale = useMutation(trpc.invoice.fromSale.mutationOptions())
  const [draftId] = useState(() => newId())
  const [error, setError] = useState<I18nKey | null>(null)
  return (
    <ConfirmDialog
      open
      icon={ReceiptIcon}
      title={t('documents.invoices.start.saleTitle')}
      body={t('documents.invoices.start.saleBody', { sale: isolate(label), amount })}
      note={t('documents.invoices.start.saleNote')}
      action={t('documents.invoices.bill.action')}
      busyLabel={t('status.saving')}
      busy={fromSale.isPending}
      error={error}
      onConfirm={() => {
        setError(null)
        fromSale
          .mutateAsync({ saleId, newId: draftId })
          .then(async (made) => {
            await refresh()
            onClose()
            router.push(`/b/${businessId}/invoices/${made.id}/edit`)
          })
          .catch((caught: unknown) =>
            setError(
              apiErrorCode(caught) === 'validation'
                ? 'documents.invoices.start.saleRefused'
                : apiErrorKey(caught),
            ),
          )
      }}
      onClose={onClose}
    />
  )
}
