'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { CreditNoteDto, InvoiceDto } from '@bizcost/contracts'
import { creditNoteKindOf } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileTextIcon, PencilIcon, StampIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { PdfDialog } from '@/features/quotations/pdf-dialog'
import { CreditNoteSheet } from './credit-note-sheet'
import { creditNoteKindKey, useRefreshInvoices } from './data'

// An invoice's credit notes (M3 Step 8; VAT ER Art. 60): each with its number and day, what it
// credits and its PDF; a draft is changed, issued (its own gapless number, CN-0001…: "it can't be
// changed after") or discarded. "Credit note" on the invoice opens the sheet; once saved, the
// confirmation to issue it follows.

type Step =
  | { kind: 'sheet'; note?: CreditNoteDto }
  | { kind: 'issue'; note: CreditNoteDto }
  | { kind: 'discard'; note: CreditNoteDto }
  | { kind: 'pdf'; id: string; number: string | null; draft: boolean }
  | null

export function useCreditNotes(invoice: InvoiceDto, today: string) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const refresh = useRefreshInvoices()
  const issue = useMutation(trpc.creditNote.issue.mutationOptions())
  const discard = useMutation(trpc.creditNote.discard.mutationOptions())
  const pdf = useMutation(trpc.creditNote.pdf.mutationOptions())
  const [step, setStep] = useState<Step>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const kind = creditNoteKindOf(invoice.kind)
  const kindName = t(creditNoteKindKey(kind))

  /** The whole credit note (a row lists only its number, day and total). */
  const load = (id: string) => queryClient.fetchQuery(trpc.creditNote.get.queryOptions({ id }))

  async function act(id: string, next: (note: CreditNoteDto) => Step) {
    try {
      setError(null)
      setStep(next(await load(id)))
    } catch (caught) {
      toast.error(t(apiErrorKey(caught)))
    }
  }

  function errorKey(caught: unknown): I18nKey {
    const code = apiErrorCode(caught)
    if (code === 'conflict') return 'documents.invoices.credit.conflict'
    if (code === 'books_closed') return 'documents.invoices.issue.booksClosed'
    if (code === 'exceeds_invoice') return 'errors.exceeds_invoice'
    return apiErrorKey(caught)
  }

  async function doIssue(note: CreditNoteDto) {
    setError(null)
    try {
      const issued = await issue.mutateAsync({ id: note.id, version: note.version })
      await refresh()
      toast.success(t('documents.invoices.credit.issued', { number: isolate(issued.number ?? '') }))
      setStep({ kind: 'pdf', id: issued.id, number: issued.number, draft: false })
    } catch (caught) {
      setError(errorKey(caught))
    }
  }

  async function doDiscard(note: CreditNoteDto) {
    setError(null)
    try {
      await discard.mutateAsync({ id: note.id, version: note.version })
      await refresh()
      toast.success(t('documents.invoices.credit.discarded'))
      setStep(null)
    } catch (caught) {
      setError(errorKey(caught))
    }
  }

  const dialogs = (
    <>
      {step?.kind === 'sheet' ? (
        <CreditNoteSheet
          invoice={invoice}
          creditNote={step.note}
          today={today}
          onSaved={(saved) => {
            setError(null)
            setStep({ kind: 'issue', note: saved })
          }}
          onClose={() => setStep(null)}
        />
      ) : null}
      <ConfirmDialog
        open={step?.kind === 'issue'}
        icon={StampIcon}
        title={t('documents.invoices.credit.issueTitle', { kind: kindName })}
        body={
          step?.kind === 'issue'
            ? t('documents.invoices.credit.issueBody', {
                amount: money(step.note.total, step.note.currency),
                number: isolate(invoice.number ?? ''),
              })
            : ''
        }
        note={t('documents.invoices.credit.issueNote')}
        action={t('documents.invoices.credit.issueAction')}
        busyLabel={t('documents.invoices.issue.issuing')}
        busy={issue.isPending}
        error={error}
        onConfirm={() => step?.kind === 'issue' && void doIssue(step.note)}
        onClose={() => {
          if (step?.kind === 'issue') toast.info(t('documents.invoices.credit.keptDraft'))
          setStep(null)
        }}
      />
      <ConfirmDialog
        open={step?.kind === 'discard'}
        icon={Trash2Icon}
        title={t('documents.invoices.credit.discardTitle')}
        body={t('documents.invoices.credit.discardBody')}
        action={t('documents.invoices.credit.discard')}
        busyLabel={t('status.removing')}
        busy={discard.isPending}
        error={error}
        destructive
        onConfirm={() => step?.kind === 'discard' && void doDiscard(step.note)}
        onClose={() => setStep(null)}
      />
      <PdfDialog
        open={step?.kind === 'pdf'}
        title={
          step?.kind === 'pdf' && !step.draft && step.number
            ? t('documents.invoices.credit.pdfIssuedTitle', { number: isolate(step.number) })
            : t('documents.invoices.credit.pdfTitle')
        }
        description={
          step?.kind === 'pdf' && step.draft
            ? t('documents.invoices.pdf.draftNote')
            : t('documents.invoices.pdf.sendNote')
        }
        shareTitle={`${kindName} ${step?.kind === 'pdf' ? (step.number ?? '') : ''}`.trim()}
        remake={step?.kind === 'pdf' ? step.id : ''}
        make={() => pdf.mutateAsync({ id: step?.kind === 'pdf' ? step.id : '' })}
        onClose={() => setStep(null)}
      />
    </>
  )

  return {
    /** Opens the sheet for a new credit note. */
    start: () => {
      setError(null)
      setStep({ kind: 'sheet' })
    },
    edit: (id: string) => act(id, (note) => ({ kind: 'sheet', note })),
    issue: (id: string) => act(id, (note) => ({ kind: 'issue', note })),
    discard: (id: string) => act(id, (note) => ({ kind: 'discard', note })),
    pdf: (id: string, number: string | null, draft: boolean) =>
      setStep({ kind: 'pdf', id, number, draft }),
    dialogs,
  }
}

/** The invoice's credit notes, with what the member may do with each. */
export function CreditNotesPanel({
  invoice,
  canCredit,
  actions,
}: {
  invoice: InvoiceDto
  canCredit: boolean
  actions: ReturnType<typeof useCreditNotes>
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const kindName = t(creditNoteKindKey(creditNoteKindOf(invoice.kind)))
  if (invoice.creditNotes.length === 0) return null
  return (
    <Panel title={t('documents.invoices.credit.listTitle')}>
      <ul className="-my-2 divide-y" aria-label={t('documents.invoices.credit.listTitle')}>
        {invoice.creditNotes.map((note) => {
          const draft = note.status === 'draft'
          return (
            <li key={note.id} data-credit-note={note.status} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-medium">
                  {note.number ? (
                    <>
                      {kindName} <bdi dir="ltr">{note.number}</bdi>
                    </>
                  ) : (
                    t('documents.invoices.credit.draftTitle', { kind: kindName })
                  )}
                </p>
                <bdi className="font-medium tabular-nums">
                  {money(note.total, invoice.currency)}
                </bdi>
              </div>
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {draft ? (
                  <Badge tone="warning">{t('documents.invoices.status.draft')}</Badge>
                ) : note.issueDate ? (
                  businessDate(note.issueDate)
                ) : null}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9"
                  onClick={() => actions.pdf(note.id, note.number, draft)}
                >
                  <FileTextIcon aria-hidden />
                  {draft ? t('documents.invoices.view.preview') : t('documents.invoices.view.pdf')}
                </Button>
                {draft && canCredit ? (
                  <>
                    <Button size="sm" className="h-9" onClick={() => void actions.issue(note.id)}>
                      <StampIcon aria-hidden />
                      {t('documents.invoices.credit.issueAction')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9"
                      onClick={() => void actions.edit(note.id)}
                    >
                      <PencilIcon aria-hidden />
                      {t('documents.invoices.view.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 text-destructive hover:text-destructive"
                      onClick={() => void actions.discard(note.id)}
                    >
                      <Trash2Icon aria-hidden />
                      {t('documents.invoices.credit.discard')}
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
