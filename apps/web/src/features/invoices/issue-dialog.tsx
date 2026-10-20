'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import { ISSUE_MISSING, type InvoiceDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { StampIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { sectionPath } from '@/features/settings/sections'
import { CountedQuestion } from './counted-question'
import { invoiceKindKey, useRefreshInvoices } from './data'

// Issuing an invoice (M3 Step 8; Q25, D-304): the confirmation says that the next number is taken
// with today's date and that the invoice can't be changed after ("To fix it, you'll issue a credit
// note", VAT ER Art. 60). What a tax invoice still needs (ER Art. 59(1), B16, C5) is listed with the way
// to add it, and the issue waits for it; "Is this sale already in your recorded sales?" is asked here
// when the draft still has no answer (Q3). A refused issue takes no number.

type Missing = (typeof ISSUE_MISSING)[number]

/** Where each missing particular is added. */
export function useMissingFix() {
  const { businessId } = useParams<{ businessId: string }>()
  return (missing: Missing, invoice: Pick<InvoiceDto, 'id' | 'customerId'>) =>
    missing === 'customer_address'
      ? {
          href: `/b/${businessId}/customers/${invoice.customerId}`,
          label: 'documents.invoices.missing.fixCustomer' as const,
        }
      : missing === 'channel'
        ? {
            href: `/b/${businessId}/invoices/${invoice.id}/edit`,
            label: 'documents.invoices.missing.fixEdit' as const,
          }
        : {
            href: sectionPath(businessId, 'business'),
            label: 'documents.invoices.missing.fixBusiness' as const,
          }
}

/** What stops the issue, each with the way to add it. */
export function MissingList({
  missing,
  invoice,
}: {
  missing: readonly Missing[]
  invoice: Pick<InvoiceDto, 'id' | 'customerId'>
}) {
  const { t } = useTranslation()
  const fix = useMissingFix()
  return (
    <ul className="space-y-1.5">
      {missing.map((item) => {
        const way = fix(item, invoice)
        return (
          <li key={item} data-issue-missing={item} className="text-sm">
            <span className="font-medium">{t(`documents.invoices.missing.${item}`)}</span>
            {' · '}
            <Link
              href={way.href}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t(way.label)}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export function IssueDialog({
  invoice,
  open,
  onIssued,
  onClose,
}: {
  invoice: InvoiceDto
  open: boolean
  onIssued: (issued: InvoiceDto) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refresh = useRefreshInvoices()
  const update = useMutation(trpc.invoice.update.mutationOptions())
  const issue = useMutation(trpc.invoice.issue.mutationOptions())
  const [answer, setAnswer] = useState<'' | 'yes' | 'no'>('')
  const [asked, setAsked] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const [refused, setRefused] = useState<Missing[]>([])
  const busy = update.isPending || issue.isPending
  const kind = t(invoiceKindKey(invoice.kind))
  const question = invoice.asksCountedElsewhere && invoice.countedElsewhere === null
  const missing = refused.length > 0 ? refused : invoice.missing

  async function doIssue() {
    setError(null)
    if (question && answer === '') {
      setAsked(true)
      return
    }
    try {
      let version = invoice.version
      if (question) {
        // The answer is saved with the draft's header as it is (an update takes the header whole).
        const saved = await update.mutateAsync({
          id: invoice.id,
          version,
          locationId: invoice.locationId,
          channelId: invoice.channelId,
          supplyDate: invoice.supplyDate,
          dueDate: invoice.dueDate,
          lpoReference: invoice.lpoReference,
          countedElsewhere: answer === 'yes',
          terms: invoice.terms,
          notes: invoice.notes,
        })
        version = saved.version
        queryClient.setQueryData(trpc.invoice.get.queryKey({ id: invoice.id }), saved)
      }
      const issued = await issue.mutateAsync({ id: invoice.id, version })
      queryClient.setQueryData(trpc.invoice.get.queryKey({ id: invoice.id }), issued)
      await refresh()
      onIssued(issued)
    } catch (caught) {
      const code = apiErrorCode(caught)
      if (code === 'details_missing') {
        setRefused(
          apiErrorNames(caught).filter((name): name is Missing =>
            (ISSUE_MISSING as readonly string[]).includes(name),
          ),
        )
        setError('documents.invoices.issue.missing')
      } else if (code === 'conflict') setError('documents.invoices.issue.conflict')
      else if (code === 'books_closed') setError('documents.invoices.issue.booksClosed')
      else setError(apiErrorKey(caught))
      await refresh()
    }
  }

  return (
    <ConfirmDialog
      open={open}
      icon={StampIcon}
      title={t('documents.invoices.issue.title', { kind })}
      body={t('documents.invoices.issue.body')}
      note={t('documents.invoices.issue.note')}
      action={t('documents.invoices.issue.action')}
      busyLabel={t('documents.invoices.issue.issuing')}
      busy={busy}
      error={error}
      disabled={missing.length > 0}
      onConfirm={() => void doIssue()}
      onClose={() => {
        setError(null)
        setAsked(false)
        setRefused([])
        onClose()
      }}
    >
      {missing.length > 0 ? (
        <div
          data-issue-blocked
          className="space-y-2 rounded-xl bg-destructive/5 p-3 ring-1 ring-destructive/20"
        >
          <p className="text-sm font-medium text-destructive">
            {t('documents.invoices.missing.title')}
          </p>
          <MissingList missing={missing} invoice={invoice} />
        </div>
      ) : question ? (
        <CountedQuestion
          value={answer}
          error={asked && answer === '' ? t('documents.invoices.counted.required') : undefined}
          onChange={setAnswer}
        />
      ) : null}
      {missing.length === 0 && invoice.number === null ? (
        <p className="text-sm text-muted-foreground">
          {t('documents.invoices.issue.customer', { name: isolate(invoice.customer.name) })}
        </p>
      ) : null}
    </ConfirmDialog>
  )
}
