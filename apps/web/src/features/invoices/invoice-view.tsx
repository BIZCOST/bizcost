'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { InvoiceDto } from '@bizcost/contracts'
import { compareDecimal, newId, subtractDecimals, sumDecimals } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CopyIcon,
  FileMinusIcon,
  FileTextIcon,
  PencilIcon,
  Share2Icon,
  StampIcon,
  Trash2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { maySeeCustomers } from '@/features/customers/data'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { PdfDialog } from '@/features/quotations/pdf-dialog'
import { maySeePayments, mayRecordPayments } from '@/features/orders/data'
import { hasModule } from '@/features/purchasing/data'
import { Receipts } from '@/features/purchasing/receipts'
import { DocumentLineList } from '@/features/quotations/document-line-list'
import { QuotationTotals } from '@/features/quotations/quotation-totals'
import { totalsOf } from '@/features/quotations/totals'
import { CustomerPaymentsPanel } from '@/features/receivables/payments-panel'
import { can, sectionPath } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { InvoiceStateBadge } from './badges'
import { CreditNotesPanel, useCreditNotes } from './credit-notes'
import {
  invoiceDtoState,
  invoiceKindKey,
  mayCreditInvoices,
  mayIssueInvoices,
  mayManageInvoices,
  useRefreshInvoices,
} from './data'
import { isScratch } from './invoice-draft'
import { InvoiceHistory } from './invoice-history'
import { useBillsSummary } from './invoice-words'
import { IssueDialog, MissingList } from './issue-dialog'

// One invoice (M3 Step 8; Q3, Q17, Q22, Q25, Q26). A draft has no number: it is changed, previewed
// (its PDF marked as a draft), issued (the confirmation says the number is taken and that a credit note
// fixes it after) or discarded; what a tax invoice still needs (the business's TRN and address, a
// registered customer's address) is listed with the way to add it, with "Add your TRN and address"
// before the first tax invoice. An issued invoice is never changed: its PDF (stored at issue) is
// downloaded or shared; a payment is recorded on it; a credit note takes part or all of it back; it is
// copied to a new quotation; its history says who did what. Its sale counts once (Q3): the page says
// on which day, or what counts it instead.

type Dialog = 'issue' | 'pdf' | 'issued' | 'discard' | 'copy' | null

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

/** Whether a credit note can still take something back (a line with something left). */
function creditLeft(invoice: InvoiceDto): boolean {
  return invoice.lines.some(
    (line) => line.kind !== 'deduction' && compareDecimal(line.left.total, '0') > 0,
  )
}

export function InvoiceView({
  invoice,
  today,
  closedThrough,
}: {
  invoice: InvoiceDto
  today: string
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const refresh = useRefreshInvoices()
  const billsOf = useBillsSummary()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const pdf = useMutation(trpc.invoice.pdf.mutationOptions())
  const discard = useMutation(trpc.invoice.discard.mutationOptions())
  const copy = useMutation(trpc.invoice.copyToQuotation.mutationOptions())
  const credits = useCreditNotes(invoice, today)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<I18nKey | null>(null)
  const [copyId] = useState(() => newId())
  if (!context) return null

  const listHref = `/b/${businessId}/invoices`
  const draft = invoice.status === 'draft'
  const vat = invoice.vatRegistered
  const tax = invoice.kind === 'tax_invoice'
  const kindName = t(invoiceKindKey(invoice.kind))
  const number = invoice.number ? isolate(invoice.number) : ''
  const title = draft
    ? t('documents.invoices.view.draftTitle', { kind: kindName })
    : t('documents.invoices.view.title', { kind: kindName, number })
  const state = invoiceDtoState(invoice)
  const canManage = mayManageInvoices(context)
  const canIssue = mayIssueInvoices(context)
  const canCredit = mayCreditInvoices(context) && !draft && creditLeft(invoice)
  const canCopy =
    canManage &&
    hasModule(context, 'quotations') &&
    can(context, 'quotations.documents.manage') &&
    invoice.lines.some((line) => line.kind === 'item')
  const firstTax =
    draft && invoice.missing.some((m) => m === 'business_trn' || m === 'business_address')
  const supply = invoice.supplyDate ?? invoice.issueDate
  const bills = billsOf(invoice)
  const totals = totalsOf({
    currency: invoice.currency,
    lines: invoice.lines.map((line) => ({
      subtotal: line.subtotal,
      discount: line.lineDiscount,
      priceIncludesVat: line.priceIncludesVat,
      vatRate: line.vatRate,
    })),
    documentDiscount: subtractDecimals(
      invoice.discountTotal,
      sumDecimals(invoice.lines.map((line) => line.lineDiscount)),
    ),
    adjustment: invoice.adjustment,
    net: invoice.netTotal,
    rates: invoice.vatRates,
    total: invoice.total,
    difference: invoice.roundingDifference,
    payable: invoice.payable,
  })

  /** What makes its sale count (Q3), as the page says it. */
  function countingNote(): string | null {
    if (invoice.orderId) {
      // Its order's delivery counted the sale: on its day once delivered, else when it is.
      return invoice.orderDeliveredOn
        ? t('documents.invoices.view.counts.orderDelivered', {
            number: isolate(invoice.orderNumber ?? ''),
            date: businessDate(invoice.orderDeliveredOn),
          })
        : t('documents.invoices.view.counts.order', {
            number: isolate(invoice.orderNumber ?? ''),
          })
    }
    if (invoice.saleId) return t('documents.invoices.view.counts.sale')
    if (invoice.isDeposit) return t('documents.invoices.view.counts.deposit')
    if (invoice.countedElsewhere === true) return t('documents.invoices.view.counts.elsewhere')
    if (draft) return null
    if (invoice.countedOn) {
      return invoice.countedOn !== supply
        ? t('documents.invoices.view.counts.moved', { date: businessDate(invoice.countedOn) })
        : t('documents.invoices.view.counts.posted', { date: businessDate(invoice.countedOn) })
    }
    return null
  }

  async function doDiscard() {
    setDialogError(null)
    try {
      await discard.mutateAsync({ id: invoice.id, version: invoice.version })
      await refresh()
      toast.success(t('documents.invoices.discard.done'))
      setDialog(null)
      router.replace(listHref)
    } catch (error) {
      setDialogError(apiErrorKey(error))
    }
  }

  async function doCopy() {
    setDialogError(null)
    try {
      const quotation = await copy.mutateAsync({ id: invoice.id, newId: copyId })
      await refresh()
      toast.success(t('documents.invoices.copy.done', { number: isolate(quotation.number) }))
      setDialog(null)
      router.push(`/b/${businessId}/quotations/${quotation.id}/edit`)
    } catch (error) {
      setDialogError(apiErrorKey(error))
    }
  }

  const counting = countingNote()

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.invoices')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 data-invoice-title className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {title}
            </h1>
            <InvoiceStateBadge state={state} creditState={invoice.creditState} />
          </div>
          <p className="mt-1.5 text-muted-foreground">
            <bdi>{invoice.customer.name}</bdi>
            {' · '}
            <bdi className="tabular-nums">{money(invoice.payable, invoice.currency)}</bdi>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {draft && canIssue ? (
            <Button data-invoice-issue onClick={() => setDialog('issue')}>
              <StampIcon aria-hidden />
              {t('documents.invoices.view.issue')}
            </Button>
          ) : null}
          {!draft ? (
            <Button data-invoice-pdf onClick={() => setDialog('pdf')}>
              <Share2Icon aria-hidden />
              {t('documents.invoices.view.pdfShare')}
            </Button>
          ) : null}
          {draft && canManage ? (
            <Button asChild variant="outline">
              <Link href={`${listHref}/${invoice.id}/edit`}>
                <PencilIcon aria-hidden />
                {t('documents.invoices.view.edit')}
              </Link>
            </Button>
          ) : null}
          {draft ? (
            <Button variant="outline" onClick={() => setDialog('pdf')}>
              <FileTextIcon aria-hidden />
              {t('documents.invoices.view.preview')}
            </Button>
          ) : null}
          {canCredit ? (
            <Button variant="outline" data-invoice-credit onClick={credits.start}>
              <FileMinusIcon aria-hidden />
              {t('documents.invoices.view.credit')}
            </Button>
          ) : null}
          {canCopy ? (
            <Button
              variant="ghost"
              onClick={() => {
                setDialogError(null)
                setDialog('copy')
              }}
            >
              <CopyIcon aria-hidden />
              {t('documents.invoices.view.copy')}
            </Button>
          ) : null}
          {draft && canManage ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setDialogError(null)
                setDialog('discard')
              }}
            >
              <Trash2Icon aria-hidden />
              {t('documents.invoices.view.discard')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6 lg:space-y-0 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-5">
          {draft ? (
            <FormAlert tone="info">{t('documents.invoices.view.draftNote')}</FormAlert>
          ) : null}
          {firstTax ? (
            <section
              data-first-tax-note
              className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-primary/30 sm:p-5"
            >
              <h2 className="font-semibold">{t('documents.invoices.firstTax.title')}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t('documents.invoices.firstTax.body')}
              </p>
              <Button asChild className="mt-3">
                <Link href={sectionPath(businessId, 'business')}>
                  {t('documents.invoices.firstTax.action')}
                </Link>
              </Button>
            </section>
          ) : null}
          {draft && invoice.missing.length > 0 && !firstTax ? (
            <FormAlert tone="error">
              <span className="block font-medium">{t('documents.invoices.missing.title')}</span>
              <MissingList missing={invoice.missing} invoice={invoice} />
            </FormAlert>
          ) : null}
          {draft
            ? invoice.warnings.map((warning) => (
                <FormAlert key={warning} tone={warning === 'late' ? 'error' : 'info'}>
                  <span data-invoice-warning={warning}>
                    {t(`documents.invoices.warnings.${warning}`, {
                      date: invoice.taxInvoiceDueBy ? businessDate(invoice.taxInvoiceDueBy) : '',
                    })}
                  </span>
                </FormAlert>
              ))
            : null}
          {draft && invoice.asksCountedElsewhere && invoice.countedElsewhere === null ? (
            <FormAlert tone="info">{t('documents.invoices.counted.beforeIssue')}</FormAlert>
          ) : null}
          {counting ? (
            <p data-invoice-counting className="text-sm text-muted-foreground">
              {counting}
            </p>
          ) : null}
          {invoice.creditState !== 'none' ? (
            <FormAlert tone="info">
              {t(
                invoice.creditState === 'credited'
                  ? 'documents.invoices.view.creditedAll'
                  : 'documents.invoices.view.creditedPart',
                { amount: money(invoice.credited, invoice.currency) },
              )}
            </FormAlert>
          ) : null}

          <Panel title={t('documents.invoices.view.details')}>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <Detail label={t('documents.invoices.editor.customer')}>
                {maySeeCustomers(context) ? (
                  <Link
                    href={`/b/${businessId}/customers/${invoice.customerId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <bdi>{invoice.customer.name}</bdi>
                  </Link>
                ) : (
                  <bdi>{invoice.customer.name}</bdi>
                )}
                {tax && invoice.customer.trn ? (
                  <span className="block text-sm font-normal text-muted-foreground">
                    {t('documents.invoices.view.trn')} <bdi dir="ltr">{invoice.customer.trn}</bdi>
                  </span>
                ) : null}
              </Detail>
              {invoice.site ? (
                <Detail label={t('documents.invoices.view.site')}>
                  <bdi>{invoice.site}</bdi>
                </Detail>
              ) : null}
              <Detail label={t('documents.invoices.view.issueDate')}>
                {invoice.issueDate ? (
                  businessDate(invoice.issueDate)
                ) : (
                  <span className="font-normal text-muted-foreground">
                    {t('documents.invoices.view.issueDateDraft')}
                  </span>
                )}
              </Detail>
              <Detail label={t('documents.invoices.editor.supplyDate')}>
                {invoice.supplyDate && invoice.supplyDate !== invoice.issueDate ? (
                  businessDate(invoice.supplyDate)
                ) : (
                  <span className="font-normal text-muted-foreground">
                    {t('documents.invoices.view.supplySame')}
                  </span>
                )}
              </Detail>
              <Detail label={t('documents.invoices.editor.dueDate')}>
                {invoice.dueDate ? (
                  <span className={invoice.overdue ? 'text-destructive' : undefined}>
                    {businessDate(invoice.dueDate)}
                  </span>
                ) : (
                  <span className="font-normal text-muted-foreground">
                    {t('documents.invoices.view.noDue')}
                  </span>
                )}
              </Detail>
              {invoice.lpoReference ? (
                <Detail label={t('documents.invoices.view.lpo')}>
                  <bdi dir="ltr">{invoice.lpoReference}</bdi>
                </Detail>
              ) : null}
              {invoice.quotationId || invoice.orderId || invoice.saleId ? (
                <Detail label={t('documents.invoices.view.from')}>
                  {invoice.orderId ? (
                    <Link
                      href={`/b/${businessId}/orders/${invoice.orderId}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t('documents.invoices.list.ofOrder', {
                        number: isolate(invoice.orderNumber ?? ''),
                      })}
                    </Link>
                  ) : invoice.quotationId ? (
                    <Link
                      href={`/b/${businessId}/quotations/${invoice.quotationId}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t('documents.invoices.list.ofQuotation', {
                        number: isolate(invoice.quotationNumber ?? ''),
                      })}
                    </Link>
                  ) : (
                    <Link
                      href={`/b/${businessId}/sales/${invoice.saleId}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t('documents.invoices.view.fromSale')}
                    </Link>
                  )}
                  {bills && !invoice.saleId ? (
                    <span
                      data-invoice-bills
                      className="block text-sm font-normal text-muted-foreground"
                    >
                      {bills}
                    </span>
                  ) : null}
                </Detail>
              ) : null}
              {context.capabilities.multi_location ? (
                <Detail label={t('sales.editor.location')}>
                  <bdi>{invoice.locationName}</bdi>
                </Detail>
              ) : null}
              {invoice.enteredByName ? (
                <Detail label={t('documents.invoices.view.preparedBy')}>
                  <bdi>{invoice.enteredByName}</bdi>
                </Detail>
              ) : null}
            </dl>
          </Panel>

          <Panel title={t('documents.invoices.editor.lines')}>
            {invoice.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('documents.invoices.list.noLines')}
              </p>
            ) : (
              <DocumentLineList
                lines={invoice.lines}
                currency={invoice.currency}
                vat={vat}
                typedLabel={isScratch(invoice) ? t('documents.invoices.editor.typed') : null}
              />
            )}
          </Panel>

          {invoice.terms || invoice.notes ? (
            <Panel title={t('documents.invoices.editor.wordsTitle')}>
              <dl className="space-y-3">
                {(['terms', 'notes'] as const).map((field) =>
                  invoice[field] ? (
                    <div key={field}>
                      <dt className="text-sm text-muted-foreground">
                        {t(`documents.invoices.editor.${field}`)}
                      </dt>
                      <dd dir="auto" className="mt-0.5 text-sm whitespace-pre-line">
                        {invoice[field]}
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </Panel>
          ) : null}

          {hasModule(context, 'files') ? (
            <Panel
              title={t('documents.invoices.files.title')}
              hint={t('documents.invoices.files.hint')}
            >
              <Receipts entity="invoice" recordId={invoice.id} canManage={canManage} />
            </Panel>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-5">
          <Panel title={t('documents.invoices.editor.totalsTitle')}>
            <QuotationTotals
              values={totals}
              vatRegistered={vat}
              money={(amount) => money(amount, invoice.currency)}
            />
          </Panel>
          {!draft && maySeePayments(context) ? (
            <CustomerPaymentsPanel
              document={{
                kind: 'invoice',
                id: invoice.id,
                businessDate: invoice.issueDate ?? today,
                label: title,
              }}
              canRecord={mayRecordPayments(context)}
              canPay
              today={today}
              closedThrough={closedThrough}
              creditedLabel={t('documents.invoices.credit.listTitle')}
            />
          ) : null}
          <CreditNotesPanel
            invoice={invoice}
            canCredit={mayCreditInvoices(context)}
            actions={credits}
          />
          <InvoiceHistory invoiceId={invoice.id} currency={invoice.currency} />
        </aside>
      </div>

      <IssueDialog
        invoice={invoice}
        open={dialog === 'issue'}
        onIssued={(issued) => {
          toast.success(
            t('documents.invoices.issue.done', { number: isolate(issued.number ?? '') }),
          )
          setDialog('issued')
        }}
        onClose={() => setDialog(null)}
      />
      <PdfDialog
        open={dialog === 'pdf' || dialog === 'issued'}
        title={
          dialog === 'issued'
            ? t('documents.invoices.pdf.issuedTitle', { number })
            : draft
              ? t('documents.invoices.pdf.previewTitle')
              : t('documents.invoices.pdf.title')
        }
        description={
          draft ? t('documents.invoices.pdf.draftNote') : t('documents.invoices.pdf.sendNote')
        }
        shareTitle={title}
        remake={`${invoice.id}:${invoice.version}`}
        make={() => pdf.mutateAsync({ id: invoice.id })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'discard'}
        icon={Trash2Icon}
        title={t('documents.invoices.discard.title')}
        body={t('documents.invoices.discard.body')}
        action={t('documents.invoices.discard.action')}
        busyLabel={t('status.removing')}
        busy={discard.isPending}
        error={dialogError}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'copy'}
        icon={CopyIcon}
        title={t('documents.invoices.copy.title')}
        body={t('documents.invoices.copy.body', { name: isolate(invoice.customer.name) })}
        action={t('documents.invoices.copy.action')}
        busyLabel={t('status.saving')}
        busy={copy.isPending}
        error={dialogError}
        onConfirm={() => void doCopy()}
        onClose={() => setDialog(null)}
      />
      {credits.dialogs}
    </PageContainer>
  )
}
