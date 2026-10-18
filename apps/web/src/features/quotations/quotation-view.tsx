'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { QuotationDto, QuotationLineDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  quotationListStatus,
  subtractDecimals,
  sumDecimals,
} from '@bizcost/domain'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClipboardListIcon,
  CopyIcon,
  FileTextIcon,
  FilePenLineIcon,
  PencilIcon,
  SendIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { useFormatQuantity, useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { CustomerPicker, type PickedCustomer } from '@/features/customers/customer-picker'
import { mayAddCustomers, maySeeCustomers } from '@/features/customers/data'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import {
  RECEIPT_ACCEPT,
  ReceiptError,
  Receipts,
  receiptProblem,
  useUploadReceipt,
} from '@/features/purchasing/receipts'
import { useChannels } from '@/features/sales/data'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { QuotationStatusBadge } from './badges'
import { mayManageQuotations, offeredActions, useRefreshQuotations } from './data'
import { QuotationPdfDialog } from './quotation-pdf'
import { QuotationTotals } from './quotation-totals'
import { totalsOf } from './totals'

// One quotation (M3 Step 7; Q21–Q25): the revision as it is (its lines by area, with their pictures,
// details and notes; its totals; its payment terms and words), and what the member may do with it.
// A draft is changed, sent (frozen, then its PDF downloaded or shared) or discarded; a sent one is
// revised (a new draft under the same number), marked accepted (with the signed copy) or declined; an
// accepted one becomes an order (with Orders on); any one is copied. Its history says who did what
// and when; its revisions and files are listed. Each action asks first, in plain words.

type Dialog =
  'send' | 'sent' | 'pdf' | 'accept' | 'decline' | 'revise' | 'copy' | 'order' | 'discard' | null

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

/** Consecutive lines of one area (or of none), as the PDF groups them. */
function groupsOf(lines: readonly QuotationLineDto[]) {
  const groups: { area: string | null; lines: QuotationLineDto[] }[] = []
  for (const line of lines) {
    const last = groups.at(-1)
    if (last && last.area === line.area) last.lines.push(line)
    else groups.push({ area: line.area, lines: [line] })
  }
  return groups
}

function LineItem({
  line,
  number,
  currency,
  vat,
}: {
  line: QuotationLineDto
  number: number
  currency: string
  vat: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const unitQuantity = useUnitQuantity()
  const amount = subtractDecimals(line.subtotal, line.lineDiscount)
  const picture = Boolean(line.picture?.url)
  // A phone gives the text the width: the amount goes under it and the picture is smaller; from md
  // the amount sits beside the text (D-297).
  return (
    <li
      data-quotation-line
      className={cn(
        'grid items-start gap-x-3 gap-y-1.5 py-3 first:pt-0 last:pb-0',
        picture
          ? 'grid-cols-[1.25rem_4rem_minmax(0,1fr)] md:grid-cols-[1.25rem_5rem_minmax(0,1fr)_auto]'
          : 'grid-cols-[1.25rem_minmax(0,1fr)] md:grid-cols-[1.25rem_minmax(0,1fr)_auto]',
      )}
    >
      <span className="row-span-2 mt-0.5 text-sm text-muted-foreground tabular-nums md:row-span-1">
        {number}
      </span>
      {line.picture?.url ? (
        // A signed URL of the business's private bucket: a plain image.
        <img
          src={line.picture.url}
          alt={t('documents.quotations.editor.pictureAlt')}
          data-line-picture
          className="row-span-2 h-12 w-16 rounded-lg border object-cover md:row-span-1 md:h-15 md:w-20"
        />
      ) : null}
      <div className="min-w-0">
        <p className="text-start font-medium break-words">
          <bdi>{line.description}</bdi>
        </p>
        {line.details ? (
          <p dir="auto" className="mt-0.5 text-sm whitespace-pre-line text-muted-foreground">
            {line.details}
          </p>
        ) : null}
        {line.note ? (
          <p dir="auto" className="mt-0.5 text-sm font-medium whitespace-pre-line text-destructive">
            {line.note}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          <bdi>
            {(line.unit ? unitQuantity(line.qty, line.unit) : line.qty).replaceAll(' ', NBSP)}
          </bdi>
          {' × '}
          <bdi className="tabular-nums">{money(line.unitPrice, currency)}</bdi>
          {line.discount ? (
            <>
              {' · '}
              {'percent' in line.discount
                ? t('purchasing.view.discountPercent', { percent: line.discount.percent })
                : t('purchasing.view.discountAmount', {
                    amount: money(line.discount.amount, currency),
                  })}
            </>
          ) : null}
          {line.typed ? <> · {t('documents.quotations.view.typed')}</> : null}
        </p>
      </div>
      <p
        className={cn(
          'pt-0.5 text-start font-medium md:row-start-1 md:text-end',
          picture ? 'col-start-3 md:col-start-4' : 'col-start-2 md:col-start-3',
        )}
      >
        <bdi className="tabular-nums">{money(amount, currency)}</bdi>
        {vat ? (
          <span className="ms-1.5 text-xs font-normal text-muted-foreground md:ms-0 md:block">
            {line.priceIncludesVat && line.vatRate !== null && compareDecimal(line.vatRate, '0') > 0
              ? t('sales.view.inclVat')
              : t('sales.list.beforeVat')}
          </span>
        ) : null}
      </p>
    </li>
  )
}

/** What happened to the quotation's revisions, newest first. */
function History({ quotationId }: { quotationId: string }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const history = useQuery(trpc.quotation.history.queryOptions({ id: quotationId }))
  const events = history.data?.events ?? []
  return (
    <Panel title={t('documents.quotations.history.title')}>
      {history.isPending ? (
        <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
      ) : history.isError ? (
        <p className="text-sm text-destructive">{t(apiErrorKey(history.error))}</p>
      ) : (
        <ol aria-label={t('documents.quotations.history.title')} className="space-y-3">
          {events.map((event, index) => (
            <li
              key={`${event.kind}-${event.revision}-${index}`}
              data-history-event={event.kind}
              className="flex gap-3"
            >
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60" />
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {t(`documents.quotations.history.kinds.${event.kind}`, {
                    revision: event.revision,
                    reference: event.reference ? isolate(event.reference) : '',
                  })}
                </p>
                <p className="text-muted-foreground">
                  {formatDate(locale, event.at, { dateStyle: 'medium', timeStyle: 'short' })}
                  {event.byName ? (
                    <>
                      {' · '}
                      <bdi>{event.byName}</bdi>
                    </>
                  ) : null}
                </p>
                {event.note ? (
                  <p dir="auto" className="mt-0.5 whitespace-pre-line text-muted-foreground">
                    {event.note}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

export function QuotationView({ quotation, today }: { quotation: QuotationDto; today: string }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const quantity = useFormatQuantity()
  const refresh = useRefreshQuotations()
  const uploadSigned = useUploadReceipt('quotation')
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { channels } = useChannels()
  const send = useMutation(trpc.quotation.send.mutationOptions())
  const accept = useMutation(trpc.quotation.accept.mutationOptions())
  const decline = useMutation(trpc.quotation.decline.mutationOptions())
  const revise = useMutation(trpc.quotation.revise.mutationOptions())
  const copy = useMutation(trpc.quotation.copy.mutationOptions())
  const toOrder = useMutation(trpc.quotation.toOrder.mutationOptions())
  const discard = useMutation(trpc.quotation.discard.mutationOptions())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [signed, setSigned] = useState<File | null>(null)
  const [copyFor, setCopyFor] = useState<PickedCustomer | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [channelId, setChannelId] = useState('')
  const [newIds] = useState(() => ({ revise: newId(), copy: newId(), order: newId() }))
  const signedInput = useRef<HTMLInputElement>(null)
  if (!context) return null

  const profile = context.terminologyProfile
  const listHref = `/b/${businessId}/quotations`
  const vat = quotation.vatRegistered
  const actions = offeredActions(quotation, context)
  const status = quotationListStatus(quotation.status, quotation.validUntil, today)
  const number = isolate(quotation.number)
  const latest = quotation.revisions.at(-1)
  const lineTotals = quotation.lines.map((line) => ({
    subtotal: line.subtotal,
    discount: line.lineDiscount,
    priceIncludesVat: line.priceIncludesVat,
    vatRate: line.vatRate,
  }))
  const totals = totalsOf({
    currency: quotation.currency,
    lines: lineTotals,
    documentDiscount: subtractDecimals(
      quotation.discountTotal,
      sumDecimals(quotation.lines.map((line) => line.lineDiscount)),
    ),
    adjustment: quotation.adjustment,
    net: quotation.netTotal,
    rates: quotation.vatRates,
    total: quotation.total,
    difference: quotation.roundingDifference,
    payable: quotation.payable,
  })

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict'
      ? 'documents.quotations.editor.conflict'
      : apiErrorKey(error)
  }

  function open(next: NonNullable<Dialog>) {
    setDialogError(null)
    setNote('')
    setSigned(null)
    if (next === 'copy') {
      setCopyFor({
        id: quotation.customerId,
        name: quotation.customerName,
        kind: 'individual',
        phone: null,
        phoneLast4: quotation.customerPhoneLast4,
        archived: false,
      })
    }
    if (next === 'order') {
      setDueDate('')
      setChannelId(channels.length > 1 ? channels[0]!.id : '')
    }
    setDialog(next)
  }

  /** Runs an action; the dialog says what went wrong, else `done` follows. */
  async function run<T>(action: () => Promise<T>, done: (result: T) => void | Promise<void>) {
    setBusy(true)
    setDialogError(null)
    try {
      const result = await action()
      await done(result)
    } catch (error) {
      setDialogError(errorKey(error))
    } finally {
      setBusy(false)
    }
  }

  const settle = async (next: QuotationDto) => {
    queryClient.setQueryData(trpc.quotation.get.queryKey({ id: next.id }), next)
    await refresh()
  }

  const doSend = () =>
    run(
      () => send.mutateAsync({ id: quotation.id, version: quotation.version }),
      async (next) => {
        await settle(next)
        toast.success(t('documents.quotations.confirm.sent', { number }))
        setDialog('sent')
      },
    )
  const doAccept = () =>
    run(
      () =>
        accept.mutateAsync({
          id: quotation.id,
          version: quotation.version,
          note: note.trim() || null,
        }),
      async (next) => {
        if (signed) {
          try {
            await uploadSigned(quotation.id, signed)
          } catch (caught) {
            toast.error(t(caught instanceof ReceiptError ? caught.key : 'errors.internal'))
          }
        }
        await settle(next)
        toast.success(t('documents.quotations.confirm.accepted', { number }))
        setDialog(null)
      },
    )
  const doDecline = () =>
    run(
      () =>
        decline.mutateAsync({
          id: quotation.id,
          version: quotation.version,
          reason: note.trim() || null,
        }),
      async (next) => {
        await settle(next)
        toast.success(t('documents.quotations.confirm.declined', { number }))
        setDialog(null)
      },
    )
  const doRevise = () =>
    run(
      () => revise.mutateAsync({ id: quotation.id, newId: newIds.revise }),
      async (next) => {
        await settle(next)
        toast.success(
          t('documents.quotations.confirm.revised', { number, revision: next.revision }),
        )
        setDialog(null)
        router.push(`${listHref}/${next.id}/edit`)
      },
    )
  const doCopy = () =>
    run(
      () =>
        copy.mutateAsync({
          id: quotation.id,
          newId: newIds.copy,
          ...(copyFor && copyFor.id !== quotation.customerId ? { customerId: copyFor.id } : {}),
        }),
      async (next) => {
        await settle(next)
        toast.success(t('documents.quotations.confirm.copied', { number: isolate(next.number) }))
        setDialog(null)
        router.push(`${listHref}/${next.id}/edit`)
      },
    )
  const doOrder = () =>
    run(
      () =>
        toOrder.mutateAsync({
          id: quotation.id,
          orderId: newIds.order,
          channelId: channelId || null,
          dueDate: dueDate || null,
        }),
      async (made) => {
        await settle(made.quotation)
        toast.success(
          t('documents.quotations.confirm.ordered', { order: isolate(made.orderNumber) }),
        )
        setDialog(null)
      },
    )
  const doDiscard = () =>
    run(
      () => discard.mutateAsync({ id: quotation.id, version: quotation.version }),
      async () => {
        await refresh()
        toast.success(t('documents.quotations.confirm.discarded', { number }))
        setDialog(null)
        router.replace(listHref)
      },
    )

  const canEdit = actions.has('update')
  const canSend = actions.has('send')
  const canRevise = actions.has('revise')
  const canAccept = actions.has('accept')
  const canDecline = actions.has('decline')
  const canOrder = actions.has('to_order')
  const canCopy = actions.has('copy')
  const canDiscard = actions.has('discard')
  const groups = groupsOf(quotation.lines)
  const hasAreas = groups.some((group) => group.area !== null)
  let counter = 0

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.quotations')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('documents.quotations.view.title', { number })}
            </h1>
            <QuotationStatusBadge status={status} />
            {quotation.revision > 1 ? (
              <span className="text-sm text-muted-foreground">
                {t('documents.quotations.view.revision', { n: quotation.revision })}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-muted-foreground">
            <bdi>{quotation.customerName}</bdi>
            {quotation.site ? (
              <>
                {' · '}
                <bdi>{quotation.site}</bdi>
              </>
            ) : null}
            {' · '}
            <bdi className="tabular-nums">{money(quotation.payable, quotation.currency)}</bdi>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSend ? (
            <Button onClick={() => open('send')}>
              <SendIcon aria-hidden />
              {t('documents.quotations.view.send')}
            </Button>
          ) : quotation.status !== 'draft' ? (
            <Button onClick={() => open('pdf')}>
              <SendIcon aria-hidden />
              {t('documents.quotations.view.sendAgain')}
            </Button>
          ) : null}
          {canAccept ? (
            <Button variant="outline" onClick={() => open('accept')}>
              <CheckCircle2Icon aria-hidden />
              {t('documents.quotations.view.accept')}
            </Button>
          ) : null}
          {canOrder ? (
            <Button variant="outline" onClick={() => open('order')}>
              <ClipboardListIcon aria-hidden />
              {t('documents.quotations.view.toOrder')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button asChild variant="outline">
              <Link href={`${listHref}/${quotation.id}/edit`}>
                <PencilIcon aria-hidden />
                {t('documents.quotations.view.edit')}
              </Link>
            </Button>
          ) : null}
          {quotation.status === 'draft' ? (
            <Button variant="outline" onClick={() => open('pdf')}>
              <FileTextIcon aria-hidden />
              {t('documents.quotations.view.preview')}
            </Button>
          ) : null}
          {canRevise ? (
            <Button variant="outline" onClick={() => open('revise')}>
              <FilePenLineIcon aria-hidden />
              {t('documents.quotations.view.revise')}
            </Button>
          ) : null}
          {canCopy ? (
            <Button variant="ghost" onClick={() => open('copy')}>
              <CopyIcon aria-hidden />
              {t('documents.quotations.view.copy')}
            </Button>
          ) : null}
          {canDecline ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => open('decline')}
            >
              <XCircleIcon aria-hidden />
              {t('documents.quotations.view.decline')}
            </Button>
          ) : null}
          {canDiscard ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => open('discard')}
            >
              <Trash2Icon aria-hidden />
              {t('documents.quotations.view.discard')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-5">
          {quotation.status === 'draft' ? (
            <FormAlert tone="info">{t('documents.quotations.view.draftNote')}</FormAlert>
          ) : null}
          {quotation.status === 'superseded' && latest && latest.id !== quotation.id ? (
            <FormAlert tone="info">
              {t('documents.quotations.view.supersededNote', { revision: latest.revision })}{' '}
              <Link
                href={`${listHref}/${latest.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('documents.quotations.view.openLatest')}
              </Link>
            </FormAlert>
          ) : null}
          {status === 'expired' && quotation.validUntil ? (
            <FormAlert tone="error">
              {t('documents.quotations.view.expiredNote', {
                date: businessDate(quotation.validUntil),
              })}
            </FormAlert>
          ) : null}
          {quotation.status === 'accepted' && quotation.acceptedAt ? (
            <FormAlert tone="info">
              {t('documents.quotations.view.acceptedNote')}
              {quotation.acceptNote ? <> {isolate(quotation.acceptNote)}</> : null}{' '}
              {quotation.orderId && quotation.orderNumber ? (
                hasModule(context, 'orders') ? (
                  <Link
                    href={`/b/${businessId}/orders/${quotation.orderId}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('documents.quotations.view.openOrder', {
                      order: isolate(quotation.orderNumber),
                    })}
                  </Link>
                ) : (
                  t('documents.quotations.view.orderMade', {
                    order: isolate(quotation.orderNumber),
                  })
                )
              ) : null}
            </FormAlert>
          ) : null}
          {quotation.status === 'declined' ? (
            <FormAlert tone="info">
              {t('documents.quotations.view.declinedNote')}
              {quotation.declineReason ? <> {isolate(quotation.declineReason)}</> : null}
            </FormAlert>
          ) : null}

          <Panel title={t('documents.quotations.view.details')}>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <Detail label={t('documents.quotations.editor.customer')}>
                {maySeeCustomers(context) ? (
                  <Link
                    href={`/b/${businessId}/customers/${quotation.customerId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{quotation.customerName}</bdi>
                  </Link>
                ) : (
                  <bdi>{quotation.customerName}</bdi>
                )}
                {quotation.customerPhoneLast4 ? (
                  <span className="block text-sm font-normal text-muted-foreground">
                    <bdi dir="ltr">…{quotation.customerPhoneLast4}</bdi>
                  </span>
                ) : null}
              </Detail>
              {quotation.site ? (
                <Detail label={term('documents.quotations.editor.site', profile)}>
                  <bdi>{quotation.site}</bdi>
                </Detail>
              ) : null}
              {quotation.customerRef ? (
                <Detail label={t('documents.quotations.editor.customerRef')}>
                  <bdi dir="ltr">{quotation.customerRef}</bdi>
                </Detail>
              ) : null}
              <Detail label={t('documents.quotations.editor.date')}>
                {businessDate(quotation.businessDate)}
              </Detail>
              <Detail label={t('documents.quotations.editor.validUntil')}>
                {quotation.validUntil ? (
                  businessDate(quotation.validUntil)
                ) : (
                  <span className="font-normal text-muted-foreground">
                    {t('documents.quotations.view.noValidity')}
                  </span>
                )}
              </Detail>
              {context.capabilities.multi_location ? (
                <Detail label={t('sales.editor.location')}>
                  <bdi>{quotation.locationName}</bdi>
                </Detail>
              ) : null}
              {quotation.enteredByName ? (
                <Detail label={t('documents.quotations.view.preparedBy')}>
                  <bdi>{quotation.enteredByName}</bdi>
                </Detail>
              ) : null}
              {quotation.copiedFromNumber ? (
                <Detail label={t('documents.quotations.view.copiedFrom')}>
                  <bdi dir="ltr">{quotation.copiedFromNumber}</bdi>
                </Detail>
              ) : null}
            </dl>
          </Panel>

          <Panel title={term('documents.quotations.editor.lines', profile)}>
            {quotation.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('documents.quotations.view.noLines')}
              </p>
            ) : (
              <div className="space-y-4">
                {groups.map((group, index) => (
                  <section
                    key={`${group.area ?? ''}-${index}`}
                    aria-label={
                      group.area ??
                      (hasAreas ? t('documents.quotations.editor.areas.none') : undefined)
                    }
                  >
                    {group.area ? (
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 border-s-4 border-primary/60 ps-2">
                        <h3
                          dir="auto"
                          data-area
                          className="text-sm font-semibold text-primary [overflow-wrap:anywhere]"
                        >
                          {group.area}
                        </h3>
                        <span data-area-count className="text-xs text-muted-foreground">
                          {t('documents.quotations.editor.areas.count', {
                            count: group.lines.length,
                          })}
                        </span>
                      </div>
                    ) : hasAreas ? (
                      // Lines without an area among areas: a heading of their own, so they never
                      // read as more lines of the area before them.
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 border-s-4 border-muted-foreground/30 ps-2">
                        <h3 data-no-area className="text-sm font-semibold text-muted-foreground">
                          {t('documents.quotations.editor.areas.none')}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          {t('documents.quotations.editor.areas.count', {
                            count: group.lines.length,
                          })}
                        </span>
                      </div>
                    ) : null}
                    <ul className="divide-y">
                      {group.lines.map((line) => {
                        counter += 1
                        return (
                          <LineItem
                            key={line.id}
                            line={line}
                            number={counter}
                            currency={quotation.currency}
                            vat={vat}
                          />
                        )
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Panel>

          {quotation.greeting || quotation.intro || quotation.terms || quotation.notes ? (
            <Panel title={t('documents.quotations.editor.wordsTitle')}>
              <dl className="space-y-3">
                {(['greeting', 'intro', 'terms', 'notes'] as const).map((field) =>
                  quotation[field] ? (
                    <div key={field}>
                      <dt className="text-sm text-muted-foreground">
                        {t(`documents.quotations.editor.${field}`)}
                      </dt>
                      <dd dir="auto" className="mt-0.5 text-sm whitespace-pre-line">
                        {quotation[field]}
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </Panel>
          ) : null}

          {hasModule(context, 'files') ? (
            <Panel
              title={t('documents.quotations.files.title')}
              hint={t('documents.quotations.files.hint')}
            >
              <Receipts
                entity="quotation"
                recordId={quotation.id}
                canManage={mayManageQuotations(context) || canAccept}
              />
            </Panel>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-5">
          <Panel title={t('documents.quotations.editor.totalsTitle')}>
            <QuotationTotals
              values={totals}
              vatRegistered={vat}
              money={(amount) => money(amount, quotation.currency)}
            />
          </Panel>
          {quotation.stages.length > 0 ? (
            <Panel title={t('documents.quotations.editor.stagesTitle')}>
              <ol className="space-y-2">
                {quotation.stages.map((stage, index) => (
                  <li key={stage.id} data-stage className="flex items-start gap-2.5 text-sm">
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {stage.label ? (
                          <bdi>{stage.label}</bdi>
                        ) : (
                          t('documents.quotations.editor.stage', { number: index + 1 })
                        )}
                      </span>
                      <span className="block text-muted-foreground">
                        <bdi>{stage.due}</bdi> ·{' '}
                        <bdi dir="ltr">{`${quantity(stage.percent)}%`}</bdi>
                      </span>
                    </span>
                    <bdi data-stage-amount className="shrink-0 font-semibold tabular-nums">
                      {money(stage.amount, quotation.currency)}
                    </bdi>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
          {quotation.revisions.length > 1 ? (
            <Panel title={t('documents.quotations.view.revisions')}>
              <ol className="space-y-2">
                {quotation.revisions.map((revision) => (
                  <li key={revision.id} className="flex items-center justify-between gap-2 text-sm">
                    {revision.id === quotation.id ? (
                      <span className="font-medium">
                        {t('documents.quotations.view.revision', { n: revision.revision })}
                      </span>
                    ) : (
                      <Link
                        href={`${listHref}/${revision.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {t('documents.quotations.view.revision', { n: revision.revision })}
                      </Link>
                    )}
                    <span className="flex items-center gap-2">
                      <QuotationStatusBadge status={revision.status} />
                      <bdi className="tabular-nums text-muted-foreground">
                        {money(revision.payable, quotation.currency)}
                      </bdi>
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
          <History quotationId={quotation.id} />
        </aside>
      </div>

      <ConfirmDialog
        open={dialog === 'send'}
        icon={SendIcon}
        title={t('documents.quotations.confirm.sendTitle', { number })}
        body={t('documents.quotations.confirm.sendBody')}
        note={t('documents.quotations.confirm.sendNote')}
        action={t('documents.quotations.confirm.sendAction')}
        busyLabel={t('documents.quotations.confirm.sending')}
        busy={busy}
        error={dialogError}
        onConfirm={() => void doSend()}
        onClose={() => setDialog(null)}
      />
      <QuotationPdfDialog
        quotation={quotation}
        open={dialog === 'pdf' || dialog === 'sent'}
        heading={
          dialog === 'sent' ? t('documents.quotations.pdf.sentTitle', { number }) : undefined
        }
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'accept'}
        icon={CheckCircle2Icon}
        title={t('documents.quotations.confirm.acceptTitle', { number })}
        body={t('documents.quotations.confirm.acceptBody')}
        note={
          canOrder || hasModule(context, 'orders')
            ? t('documents.quotations.confirm.acceptNote')
            : undefined
        }
        action={t('documents.quotations.confirm.acceptAction')}
        busyLabel={t('status.saving')}
        busy={busy}
        error={dialogError}
        onConfirm={() => void doAccept()}
        onClose={() => setDialog(null)}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('documents.quotations.confirm.signed')}</p>
            <input
              ref={signedInput}
              type="file"
              accept={RECEIPT_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              data-signed-input
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                const problem = receiptProblem(file)
                setDialogError(problem)
                setSigned(problem ? null : file)
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => signedInput.current?.click()}>
                {signed
                  ? t('documents.quotations.confirm.signedChange')
                  : t('documents.quotations.confirm.signedPick')}
              </Button>
              {signed ? (
                <span dir="auto" data-signed-name className="min-w-0 truncate text-sm">
                  {signed.name}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('documents.quotations.confirm.signedHint')}
            </p>
          </div>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t('documents.quotations.confirm.acceptNoteLabel')}</span>
            <Textarea
              className="[unicode-bidi:plaintext]"
              dir="auto"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'decline'}
        icon={XCircleIcon}
        title={t('documents.quotations.confirm.declineTitle', { number })}
        body={t('documents.quotations.confirm.declineBody')}
        action={t('documents.quotations.confirm.declineAction')}
        busyLabel={t('status.saving')}
        busy={busy}
        error={dialogError}
        destructive
        onConfirm={() => void doDecline()}
        onClose={() => setDialog(null)}
      >
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t('documents.quotations.confirm.declineReason')}</span>
          <Textarea
            className="[unicode-bidi:plaintext]"
            dir="auto"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'revise'}
        icon={FilePenLineIcon}
        title={t('documents.quotations.confirm.reviseTitle', {
          number,
          revision: (latest?.revision ?? quotation.revision) + 1,
        })}
        body={t('documents.quotations.confirm.reviseBody', { revision: quotation.revision })}
        note={
          quotation.status === 'accepted'
            ? t('documents.quotations.confirm.reviseAccepted')
            : t('documents.quotations.confirm.reviseNote')
        }
        action={t('documents.quotations.confirm.reviseAction')}
        busyLabel={t('status.saving')}
        busy={busy}
        error={dialogError}
        onConfirm={() => void doRevise()}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'copy'}
        icon={CopyIcon}
        title={t('documents.quotations.confirm.copyTitle', { number })}
        body={t('documents.quotations.confirm.copyBody')}
        action={t('documents.quotations.confirm.copyAction')}
        busyLabel={t('status.saving')}
        busy={busy}
        error={dialogError}
        disabled={copyFor === null}
        onConfirm={() => void doCopy()}
        onClose={() => setDialog(null)}
      >
        <TextField
          label={t('documents.quotations.editor.customer')}
          render={(a11y) => (
            <CustomerPicker
              value={copyFor}
              label={t('documents.quotations.editor.customer')}
              describedBy={a11y['aria-describedby']}
              canAdd={mayAddCustomers(context)}
              onChange={setCopyFor}
            />
          )}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'order'}
        icon={ClipboardListIcon}
        title={t('documents.quotations.confirm.orderTitle', { number })}
        body={t('documents.quotations.confirm.orderBody', {
          amount: money(quotation.payable, quotation.currency),
        })}
        note={t('documents.quotations.confirm.orderNote')}
        action={t('documents.quotations.confirm.orderAction')}
        busyLabel={t('status.saving')}
        busy={busy}
        error={dialogError}
        onConfirm={() => void doOrder()}
        onClose={() => setDialog(null)}
      >
        <div className="space-y-4">
          <TextField
            label={t('orders.editor.dueDate')}
            type="date"
            min={today}
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            hint={(id) => (
              <p id={id} className="text-sm text-muted-foreground">
                {t('orders.optional')}
              </p>
            )}
          />
          {channels.length > 1 ? (
            <TextField
              label={term('orders.editor.channel', profile)}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value)}
                >
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
          ) : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'discard'}
        icon={Trash2Icon}
        title={t('documents.quotations.confirm.discardTitle', { number })}
        body={t('documents.quotations.confirm.discardBody')}
        action={t('documents.quotations.confirm.discardAction')}
        busyLabel={t('status.removing')}
        busy={busy}
        error={dialogError}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setDialog(null)}
      />
    </PageContainer>
  )
}
