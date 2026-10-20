'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { OrderDto, OrderResultDto, ProfitPartsDto } from '@bizcost/contracts'
import { compareDecimal, subtractDecimals, type TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  PackageCheckIcon,
  PencilIcon,
  ReceiptTextIcon,
  RotateCcwIcon,
  Undo2Icon,
  XCircleIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { maySeeCustomers } from '@/features/customers/data'
import {
  Locked,
  Money,
  useBusinessDate,
  useBusinessWeekday,
  useMoney,
} from '@/features/documents/amounts'
import { firstOpenDay } from '@/features/documents/books'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { Totals } from '@/features/documents/totals'
import { BillDialog } from '@/features/invoices/bill-dialog'
import { mayManageInvoices, mayViewInvoices } from '@/features/invoices/data'
import { SourceInvoices, useInvoicedInFull } from '@/features/invoices/source-invoices'
import { hasModule } from '@/features/purchasing/data'
import { Receipts } from '@/features/purchasing/receipts'
import { CustomerPaymentsPanel } from '@/features/receivables/payments-panel'
import { useCountedAmount } from '@/features/sales/data'
import { RefundSheet } from '@/features/sales/refund-sheet'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CustomerRef, OrderStatusBadge, PaymentBadge } from './badges'
import {
  mayDeliverOrders,
  mayEnterOrders,
  mayRecordPayments,
  mayReverseOrders,
  useRefreshOrders,
} from './data'

// One order (M3 Step 5; Q16, Q17, D-265, D-270): what was ordered, by whom and when it is due, its
// delivery, its totals, and apart from its status how it is paid (Paid / Deposit paid / Not paid),
// with its payments. A pending order is delivered ("This counts as a sale on Thu 8 Oct: AED 170.00"),
// changed or cancelled; a delivered one is refunded or its delivery undone (it waits again, and its
// sale is reversed). A delivered order shows what it really earned, for a member with the costs
// switch. Each action asks first, saying in plain words what changes.

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

const isLoss = (value: string | null | undefined) =>
  typeof value === 'string' && compareDecimal(value, '0') < 0
const nonZero = (value: string | null | undefined): value is string =>
  typeof value === 'string' && compareDecimal(value, '0') !== 0

/** What a delivered order really earned (D-270): its sale and refunds, as Real profit works it out. */
function OrderProfit({
  profit,
  currency,
  vat,
  ownerTime,
  profile,
}: {
  profit: ProfitPartsDto
  currency: string
  vat: boolean
  ownerTime: boolean
  profile: TerminologyProfile
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const rows: { id: string; label: string; value: string | null | undefined; strong?: boolean }[] =
    [
      {
        id: 'sales',
        label: t(vat ? 'orders.profit.salesBeforeVat' : 'orders.profit.sales'),
        value: profit.sales,
      },
      { id: 'materials', label: term('orders.profit.materials', profile), value: profit.materials },
    ]
  if (nonZero(profit.fees))
    rows.push({ id: 'fees', label: t('orders.profit.fees'), value: profit.fees })
  if (nonZero(profit.deliveryCharged) || nonZero(profit.deliveryCost)) {
    rows.push({ id: 'delivery', label: t('orders.profit.delivery'), value: profit.deliveryCost })
  }
  rows.push({ id: 'running', label: t('orders.profit.running'), value: profit.runningCosts })
  if (ownerTime) rows.push({ id: 'time', label: t('orders.profit.time'), value: profit.ownerTime })
  const value = profit.profit ?? null
  return (
    <Panel title={t('orders.profit.title')} hint={t('orders.profit.hint')}>
      <dl className="divide-y">
        {rows.map((row) => (
          <div
            key={row.id}
            data-part={row.id}
            className="flex items-baseline justify-between gap-4 py-2"
          >
            <dt className="min-w-0 text-sm">{row.label}</dt>
            <dd className="text-end text-sm font-medium">
              {row.value === undefined ? (
                <Locked category="cost" />
              ) : row.value === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <bdi className="tabular-nums">
                  {row.id === 'sales' || !nonZero(row.value) ? '' : '− '}
                  {money(row.value.replace(/^-/, ''), currency)}
                </bdi>
              )}
            </dd>
          </div>
        ))}
        <div data-part="profit" className="flex items-baseline justify-between gap-4 pt-3">
          <dt className="font-semibold">
            {t(isLoss(value) ? 'orders.profit.loss' : 'orders.profit.profit')}
          </dt>
          <dd className="text-end">
            {value === null ? (
              <Locked category="profit_margin" />
            ) : (
              <bdi
                data-order-profit
                className={cn(
                  'text-lg font-semibold tabular-nums',
                  isLoss(value) ? 'text-loss' : 'text-profit',
                )}
              >
                {money(value.replace(/^-/, ''), currency)}
              </bdi>
            )}
          </dd>
        </div>
      </dl>
      {profit.complete === false ? (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm leading-relaxed">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{t('orders.profit.incomplete')}</span>
        </p>
      ) : null}
      {profit.beforeRunningCosts === true ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('orders.profit.beforeRunning')}</p>
      ) : null}
    </Panel>
  )
}

/** The order's own refund sheet: it reads the order's sale (what is left of each line). */
function OrderRefund({
  order,
  today,
  closedThrough,
  onClose,
}: {
  order: OrderDto
  today: string
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const sale = useQuery({
    ...trpc.sale.get.queryOptions({ id: order.saleId ?? '' }),
    enabled: order.saleId !== null,
  })
  // The sale can't be read (gone, or no longer open to the member): said, and the sheet stays shut.
  const failed = sale.isError ? sale.error : null
  useEffect(() => {
    if (!failed) return
    toast.error(t(apiErrorKey(failed)))
    onClose()
  }, [failed, onClose, t])
  if (!context || !sale.data) return null
  return (
    <RefundSheet
      sale={sale.data.data}
      orderId={order.id}
      label={t('orders.view.title', { number: isolate(order.number) })}
      owed={order.payment}
      canGiveBack={mayRecordPayments(context)}
      today={today}
      closedThrough={closedThrough}
      onClose={onClose}
    />
  )
}

export function OrderView({
  result,
  today,
  closedThrough,
}: {
  result: OrderResultDto
  today: string
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const weekday = useBusinessWeekday()
  const unitQuantity = useUnitQuantity()
  const counted = useCountedAmount()
  const refresh = useRefreshOrders()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const order = result.data
  const deliver = useMutation(trpc.order.deliver.mutationOptions())
  const cancel = useMutation(trpc.order.cancel.mutationOptions())
  const undo = useMutation(trpc.order.undoDelivery.mutationOptions())
  const [confirm, setConfirm] = useState<
    'deliver' | 'cancel' | 'undo' | 'refund' | 'invoice' | null
  >(null)
  // M3 Step 8: once an order has an issued invoice, what is owed lives on its invoices (A2).
  const invoicesSeen = context !== undefined && mayViewInvoices(context)
  const issuedInvoices = useQuery({
    ...trpc.invoice.list.queryOptions({ orderId: order.id, status: 'issued', limit: 1 }),
    enabled: invoicesSeen,
  })
  const invoiced = (issuedInvoices.data?.items.length ?? 0) > 0
  const invoicedInFull = useInvoicedInFull({ orderId: order.id }, order.total, invoicesSeen)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  // The delivery day (never after today, never before the order's day or in closed books).
  const openFrom = firstOpenDay(today, closedThrough)
  const earliest = openFrom && openFrom > order.businessDate ? openFrom : order.businessDate
  const [deliveredOn, setDeliveredOn] = useState(today)
  const [reason, setReason] = useState('')
  if (!context) return null

  const profile = context.terminologyProfile
  const listHref = `/b/${businessId}/orders`
  const vat = order.vatRegistered
  const pending = order.status === 'pending'
  const delivered = order.status === 'delivered'
  const cancelled = order.status === 'cancelled'
  const canDeliver = mayDeliverOrders(context) && pending
  const canEdit = mayEnterOrders(context) && pending
  const canCancel = mayEnterOrders(context) && pending
  const salesOn = hasModule(context, 'sales')
  const canRefund = mayReverseOrders(context) && delivered && salesOn && order.saleId !== null
  const canUndo = mayReverseOrders(context) && delivered
  const items = order.lines.filter((line) => line.kind === 'item')
  const delivery = order.lines.find((line) => line.kind === 'delivery')
  const shownDeliveryCost = order.mine ? order.ownDeliveryCost : order.deliveryCost
  const standingRefunds = order.refunds.filter((refund) => refund.status === 'posted')
  // The books stop the delivery when they are closed up to today (no day can be picked).
  const deliverBlocked = closedThrough !== null && closedThrough >= today
  const undoBlocked =
    closedThrough !== null && order.deliveredOn !== null && order.deliveredOn <= closedThrough
  const sameYear = today
  // The VAT registration changed since the order was saved: its delivery works its amounts out again
  // (D-273), so the confirmation says so rather than an amount that would not be the one counted.
  const vatChanged =
    pending && (context.capabilities.vat_registered === true) !== order.vatRegistered
  const canSeeSale = salesOn && can(context, 'sales.documents.view')
  const canInvoice =
    !cancelled && order.customerId !== null && !invoicedInFull && mayManageInvoices(context)

  function errorKey(error: unknown): I18nKey {
    const code = apiErrorCode(error)
    if (code === 'conflict') return 'orders.conflict'
    if (code === 'books_closed') return 'orders.confirm.booksClosed'
    return apiErrorKey(error)
  }

  async function run(
    action: () => Promise<OrderResultDto>,
    done: I18nKey,
    values?: Record<string, string>,
  ) {
    setBusy(true)
    setConfirmError(null)
    try {
      const next = await action()
      queryClient.setQueryData(trpc.order.get.queryKey({ id: order.id }), next)
      await refresh()
      toast.success(t(done, values))
      setConfirm(null)
    } catch (error) {
      setConfirmError(errorKey(error))
    } finally {
      setBusy(false)
    }
  }

  const doDeliver = () =>
    run(
      () =>
        deliver.mutateAsync({
          id: order.id,
          version: order.version,
          businessDate: deliveredOn,
        }),
      'orders.confirm.delivered',
      { number: isolate(order.number) },
    )
  const doCancel = () =>
    run(
      () =>
        cancel.mutateAsync({
          id: order.id,
          version: order.version,
          reason: reason.trim() || null,
        }),
      'orders.confirm.cancelled',
      { number: isolate(order.number) },
    )
  const doUndo = () =>
    run(() => undo.mutateAsync({ id: order.id }), 'orders.confirm.undone', {
      number: isolate(order.number),
    })

  const open = (next: NonNullable<typeof confirm>) => {
    setConfirmError(null)
    if (next === 'deliver') setDeliveredOn(today < earliest ? earliest : today)
    setConfirm(next)
  }

  const deliverDayProblem: I18nKey | null =
    deliveredOn === '' || deliveredOn > today
      ? 'errors.future_date'
      : deliveredOn < order.businessDate
        ? 'orders.confirm.deliverBeforeOrder'
        : openFrom !== undefined && deliveredOn < openFrom
          ? 'orders.confirm.booksClosed'
          : null

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.orders')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('orders.view.title', { number: isolate(order.number) })}
            </h1>
            <OrderStatusBadge status={order.status} />
            {order.payment ? (
              <PaymentBadge state={order.payment.state} pending={pending} cancelled={cancelled} />
            ) : null}
          </div>
          <p className="mt-1.5 text-muted-foreground">
            {order.customerName ? <bdi>{order.customerName}</bdi> : t('orders.view.noCustomer')}
            {order.customerRef ? (
              <>
                {' · '}
                <CustomerRef value={order.customerRef} />
              </>
            ) : null}
            {' · '}
            {money(order.total, order.currency)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canDeliver ? (
            <Button onClick={() => open('deliver')}>
              <PackageCheckIcon aria-hidden />
              {t('orders.view.deliver')}
            </Button>
          ) : null}
          {canInvoice ? (
            <Button
              variant={canDeliver ? 'outline' : 'default'}
              data-order-invoice
              onClick={() => open('invoice')}
            >
              <ReceiptTextIcon aria-hidden />
              {t('documents.invoices.links.invoiceOrder')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button asChild variant="outline">
              <Link href={`${listHref}/${order.id}/edit`}>
                <PencilIcon aria-hidden />
                {t('orders.view.edit')}
              </Link>
            </Button>
          ) : null}
          {canRefund ? (
            <Button variant="outline" onClick={() => open('refund')}>
              <RotateCcwIcon aria-hidden />
              {t('orders.view.refund')}
            </Button>
          ) : null}
          {canUndo ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => open('undo')}
            >
              <Undo2Icon aria-hidden />
              {t('orders.view.undo')}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setReason('')
                open('cancel')
              }}
            >
              <XCircleIcon aria-hidden />
              {t('orders.view.cancel')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5">
        {delivered && order.deliveredOn ? (
          <FormAlert tone="info">
            {t('orders.view.deliveredNote', {
              date: businessDate(order.deliveredOn),
              amount: counted(order),
            })}{' '}
            {order.saleId && canSeeSale ? (
              <Link
                href={`/b/${businessId}/sales/${order.saleId}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('orders.view.openSale')}
              </Link>
            ) : null}
          </FormAlert>
        ) : null}
        {cancelled ? (
          <FormAlert tone="info">
            {t('orders.view.cancelledNote')}
            {order.cancelReason ? (
              <> {t('orders.view.cancelReason', { reason: isolate(order.cancelReason) })}</>
            ) : null}
          </FormAlert>
        ) : null}
        {pending && order.dueDate && order.dueDate < today ? (
          <FormAlert tone="error">
            {t('orders.view.late', { date: businessDate(order.dueDate) })}
          </FormAlert>
        ) : null}
        {result.meta.redacted.length > 0 && delivered ? (
          <p className="text-sm text-muted-foreground">{t('orders.view.costsHidden')}</p>
        ) : null}

        <Panel title={t('sales.editor.details')}>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Detail label={t('orders.editor.customer')}>
              {order.customerName ? (
                order.customerId && maySeeCustomers(context) ? (
                  <Link
                    href={`/b/${businessId}/customers/${order.customerId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{order.customerName}</bdi>
                  </Link>
                ) : (
                  <bdi>{order.customerName}</bdi>
                )
              ) : (
                <span className="font-normal text-muted-foreground">
                  {t('orders.view.noCustomer')}
                </span>
              )}
              {order.customerPhoneLast4 ? (
                <span className="block text-sm font-normal text-muted-foreground">
                  <bdi dir="ltr">…{order.customerPhoneLast4}</bdi>
                </span>
              ) : null}
            </Detail>
            {order.customerRef ? (
              <Detail label={term('orders.editor.customerRef', profile)}>
                <CustomerRef value={order.customerRef} />
              </Detail>
            ) : null}
            <Detail label={t('orders.editor.date')}>{businessDate(order.businessDate)}</Detail>
            <Detail label={t('orders.editor.dueDate')}>
              {order.dueDate ? (
                weekday(order.dueDate, sameYear)
              ) : (
                <span className="font-normal text-muted-foreground">{t('orders.view.noDue')}</span>
              )}
            </Detail>
            <Detail label={term('orders.editor.channel', profile)}>
              <bdi>{order.channelName}</bdi>
            </Detail>
            {context.capabilities.multi_location ? (
              <Detail label={t('sales.editor.location')}>
                <bdi>{order.locationName}</bdi>
              </Detail>
            ) : null}
            {order.enteredByName ? (
              <Detail label={t('orders.view.enteredByLabel')}>
                <bdi>{order.enteredByName}</bdi>
              </Detail>
            ) : null}
          </dl>
          {order.notes ? (
            <p dir="auto" data-order-notes className="mt-4 text-sm whitespace-pre-line">
              {order.notes}
            </p>
          ) : null}
        </Panel>

        <Panel title={t('orders.editor.items')}>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('orders.view.noItems')}</p>
          ) : (
            <ul aria-label={t('orders.editor.items')} className="divide-y">
              {items.map((line) => (
                <li key={line.id} data-order-line className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-start font-medium break-words">
                        <bdi>{line.description}</bdi>
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <bdi>
                          {(line.unit ? unitQuantity(line.qty, line.unit) : line.qty).replaceAll(
                            ' ',
                            NBSP,
                          )}
                        </bdi>
                        {' × '}
                        <bdi className="tabular-nums">{money(line.unitPrice, order.currency)}</bdi>
                        {vat && line.priceIncludesVat ? (
                          <> {t('sales.view.inclVat').replaceAll(' ', NBSP)}</>
                        ) : null}
                        {line.discount ? (
                          <>
                            {' · '}
                            {'percent' in line.discount
                              ? t('purchasing.view.discountPercent', {
                                  percent: line.discount.percent,
                                })
                              : t('purchasing.view.discountAmount', {
                                  amount: money(line.discount.amount, order.currency),
                                })}
                          </>
                        ) : null}
                      </p>
                    </div>
                    <p className="shrink-0 pt-0.5 text-end font-medium">
                      <Money value={line.net} currency={order.currency} />
                      {vat ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {t('sales.list.beforeVat')}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {order.discount ? (
            <p data-order-discount className="mt-3 border-t pt-3 text-sm text-muted-foreground">
              {'percent' in order.discount
                ? t('orders.view.discountPercent', { percent: order.discount.percent })
                : t('orders.view.discountAmount', {
                    amount: money(order.discount.amount, order.currency),
                  })}
            </p>
          ) : null}
        </Panel>

        {order.deliveryNeeded ? (
          <Panel title={t('sales.editor.delivery')}>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {order.deliveryArea ? (
                <Detail label={t('sales.editor.deliveryArea')}>
                  <bdi>{order.deliveryArea}</bdi>
                </Detail>
              ) : null}
              <Detail label={t('sales.view.deliveryCharged')}>
                {delivery ? (
                  <bdi className="tabular-nums">{money(delivery.net, order.currency)}</bdi>
                ) : (
                  t('sales.view.deliveryFree')
                )}
              </Detail>
              <Detail label={t('sales.editor.deliveryCost')}>
                {shownDeliveryCost === undefined ? (
                  <Locked category="cost" />
                ) : shownDeliveryCost === null ? (
                  <span className="font-normal text-muted-foreground">
                    {t('sales.view.deliveryCostMissing')}
                  </span>
                ) : (
                  <bdi data-delivery-cost className="tabular-nums">
                    {money(shownDeliveryCost, order.currency)}
                  </bdi>
                )}
              </Detail>
            </dl>
            {typeof shownDeliveryCost === 'string' ? (
              <p data-delivery-margin className="mt-4 text-sm">
                {(() => {
                  const margin = subtractDecimals(delivery?.net ?? '0', shownDeliveryCost)
                  return isLoss(margin)
                    ? t('orders.view.deliveryPays', {
                        amount: money(margin.replace(/^-/, ''), order.currency),
                      })
                    : t('orders.view.deliveryEarns', { amount: money(margin, order.currency) })
                })()}
              </p>
            ) : null}
          </Panel>
        ) : null}

        <Panel title={t('purchasing.totals.title')}>
          <Totals
            subtotal={order.subtotal}
            discount={order.discountTotal}
            net={order.netTotal}
            vat={order.vatTotal}
            total={order.total}
            vatRegistered={vat}
            money={(amount) => money(amount, order.currency)}
          />
        </Panel>

        {order.payment ? (
          <CustomerPaymentsPanel
            document={{
              kind: 'order',
              id: order.id,
              businessDate: order.businessDate,
              label: t('orders.view.title', { number: isolate(order.number) }),
            }}
            canRecord={mayRecordPayments(context)}
            // Invoiced in part, the order still takes payments for what is not invoiced yet (they
            // count toward its invoices first, D-313); invoiced in full, its invoices take them.
            canPay={!cancelled && !order.paidThroughInvoices}
            cancelled={cancelled}
            today={today}
            closedThrough={closedThrough}
            hint={
              order.paidThroughInvoices
                ? t('documents.invoices.links.paidOnInvoices')
                : invoiced
                  ? t('documents.invoices.links.paidOnOrderToo')
                  : cancelled && compareDecimal(order.payment.overpaid, '0') > 0
                    ? t('orders.view.cancelledPayments')
                    : undefined
            }
          />
        ) : null}

        {invoicesSeen ? (
          <SourceInvoices filter={{ orderId: order.id }} currency={order.currency} />
        ) : null}

        {order.refunds.length > 0 ? (
          <Panel title={t('orders.view.refunds')}>
            <ul aria-label={t('orders.view.refunds')} className="divide-y">
              {order.refunds.map((refund) => (
                <li
                  key={refund.id}
                  data-refund
                  className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {canSeeSale ? (
                        <Link
                          href={`/b/${businessId}/sales/${refund.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {t(`orders.view.refundBy.${refund.by}`)}
                        </Link>
                      ) : (
                        t(`orders.view.refundBy.${refund.by}`)
                      )}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {businessDate(refund.businessDate)}
                      {refund.status === 'reversed' ? (
                        <> · {t('orders.view.refundReversed')}</>
                      ) : null}
                    </p>
                  </div>
                  <bdi
                    className={cn(
                      'shrink-0 font-medium tabular-nums',
                      refund.status === 'reversed' && 'text-muted-foreground line-through',
                    )}
                  >
                    {money(refund.total, order.currency)}
                  </bdi>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {delivered && order.profit ? (
          <OrderProfit
            profit={order.profit}
            currency={order.currency}
            vat={vat}
            ownerTime={context.capabilities.has_team !== true}
            profile={profile}
          />
        ) : null}

        {hasModule(context, 'files') ? (
          <Panel title={t('orders.files.title')} hint={term('orders.files.hint', profile)}>
            <Receipts entity="order" recordId={order.id} canManage={mayEnterOrders(context)} />
          </Panel>
        ) : null}
      </div>

      {confirm === 'invoice' ? (
        <BillDialog
          source={{
            kind: 'order',
            id: order.id,
            number: order.number,
            payable: order.total,
            currency: order.currency,
            stages: [],
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirm === 'deliver'}
        icon={PackageCheckIcon}
        title={t('orders.confirm.deliverTitle', { number: isolate(order.number) })}
        body={
          vatChanged
            ? t('orders.confirm.deliverBodyVatChanged', {
                date: weekday(deliveredOn || today, sameYear),
              })
            : t('orders.confirm.deliverBody', {
                date: weekday(deliveredOn || today, sameYear),
                amount: counted(order),
              })
        }
        note={t(vatChanged ? 'orders.confirm.deliverNoteVatChanged' : 'orders.confirm.deliverNote')}
        action={t('orders.view.deliver')}
        busyLabel={t('orders.confirm.delivering')}
        busy={busy}
        error={confirmError ?? (deliverBlocked ? 'orders.confirm.closedToday' : deliverDayProblem)}
        disabled={deliverBlocked || deliverDayProblem !== null}
        onConfirm={() => void doDeliver()}
        onClose={() => setConfirm(null)}
      >
        {deliverBlocked ? null : (
          <TextField
            label={t('orders.confirm.deliveredOn')}
            type="date"
            min={earliest}
            max={today}
            value={deliveredOn}
            onChange={(event) => setDeliveredOn(event.target.value)}
          />
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'cancel'}
        icon={XCircleIcon}
        title={t('orders.confirm.cancelTitle', { number: isolate(order.number) })}
        body={t('orders.confirm.cancelBody')}
        note={
          order.payment && compareDecimal(order.payment.paid, order.payment.refunded) > 0
            ? t('orders.confirm.cancelPaid', {
                amount: money(
                  subtractDecimals(order.payment.paid, order.payment.refunded),
                  order.currency,
                ),
              })
            : t('orders.confirm.cancelNote')
        }
        action={t('orders.confirm.cancelAction')}
        busyLabel={t('status.cancelling')}
        busy={busy}
        error={confirmError}
        destructive
        onConfirm={() => void doCancel()}
        onClose={() => setConfirm(null)}
      >
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t('orders.confirm.cancelReason')}</span>
          <Textarea
            className="[unicode-bidi:plaintext]"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'undo'}
        icon={Undo2Icon}
        title={t('orders.confirm.undoTitle', { number: isolate(order.number) })}
        body={t('orders.confirm.undoBody', {
          date: order.deliveredOn ? businessDate(order.deliveredOn) : '',
        })}
        note={
          standingRefunds.length > 0
            ? t('orders.confirm.undoRefunds')
            : t('orders.confirm.undoNote')
        }
        action={t('orders.view.undo')}
        busyLabel={t('orders.confirm.undoing')}
        busy={busy}
        error={
          confirmError ??
          // Refunds that stand are said once, in the note (the button waits for them).
          (standingRefunds.length === 0 && undoBlocked ? 'orders.confirm.undoClosed' : null)
        }
        disabled={standingRefunds.length > 0 || undoBlocked}
        destructive
        onConfirm={() => void doUndo()}
        onClose={() => setConfirm(null)}
      />
      {confirm === 'refund' ? (
        <OrderRefund
          order={order}
          today={today}
          closedThrough={closedThrough}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </PageContainer>
  )
}
