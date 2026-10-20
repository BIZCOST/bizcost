'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  billingError,
  billPart,
  compareDecimal,
  newId,
  subtractDecimals,
  sumDecimals,
  type BillingPart,
  type CurrencyCode,
  type InvoiceBills,
  type Money,
  type Percent,
} from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ReceiptTextIcon } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { readAmount, readPercent, withLatinDigits } from '@/features/catalog/numbers'
import { useFormatQuantity } from '@/features/catalog/unit-parts'
import { useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { MoneyInput } from '@/features/documents/line-editor'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { useRefreshInvoices } from './data'

// "This invoice bills" (M3 Step 8; Q22): a draft invoice from an accepted quotation or an order bills
// everything (nothing billed yet), a part (a % or an amount; a deposit before the work, which the
// final invoice takes off before VAT), the rest (the last part, or the final invoice after deposits),
// or one of the quotation's payment stages, billed in their order, each once (those invoiced are
// marked, only the next is chosen; the last bills all that is left, and says how much). What was
// invoiced already is listed; the API works the part out and refuses what can't be billed. Made as a
// draft, it opens in the editor: its dates, LPO and words, then Issue.

export interface BillSource {
  readonly kind: 'quotation' | 'order'
  readonly id: string
  readonly number: string
  /** What the customer is asked to pay in all (null: not known here). */
  readonly payable: string | null
  readonly currency: string
  /** A quotation's payment stages (empty: none). */
  readonly stages: readonly {
    readonly label: string | null
    readonly percent: string
    readonly amount: string
  }[]
}

/** Why a part can't be billed (the domain's codes). */
type BillingCode = Exclude<ReturnType<typeof billingError>, null>

type Choice = { kind: 'bills'; bills: InvoiceBills } | { kind: 'stage'; stage: number }

export function BillDialog({
  source,
  start,
  onClose,
}: {
  source: BillSource
  /** Chosen to start with (a deposit recorded without its invoice: that amount, as a deposit). */
  start?: { bills: InvoiceBills; partKind: 'percent' | 'amount'; part: string; isDeposit: boolean }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const router = useRouter()
  const money = useMoney()
  const quantity = useFormatQuantity()
  const refresh = useRefreshInvoices()
  const partId = useId()
  const { businessId } = useParams<{ businessId: string }>()
  const fromQuotation = useMutation(trpc.invoice.fromQuotation.mutationOptions())
  const fromOrder = useMutation(trpc.invoice.fromOrder.mutationOptions())
  const issued = useQuery(
    trpc.invoice.list.queryOptions(
      source.kind === 'quotation'
        ? { quotationId: source.id, status: 'issued', limit: 50 }
        : { orderId: source.id, status: 'issued', limit: 50 },
    ),
  )
  const [draftId] = useState(() => newId())
  const [choice, setChoice] = useState<Choice | null>(
    start ? { kind: 'bills', bills: start.bills } : null,
  )
  const [partKind, setPartKind] = useState<'percent' | 'amount'>(start?.partKind ?? 'percent')
  const [part, setPart] = useState(start?.part ?? '')
  const [isDeposit, setIsDeposit] = useState(start?.isDeposit ?? false)
  const [error, setError] = useState<I18nKey | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const busy = fromQuotation.isPending || fromOrder.isPending

  const currency = source.currency as CurrencyCode
  const billed = issued.data?.items ?? []
  const deposits = billed.filter((invoice) => invoice.isDeposit)
  const staged = source.stages.length > 0 && deposits.length === 0
  const nothingBilled = issued.isSuccess && billed.length === 0
  const sourceName =
    source.kind === 'quotation'
      ? t('documents.invoices.bill.ofQuotation', { number: isolate(source.number) })
      : t('documents.invoices.bill.ofOrder', { number: isolate(source.number) })
  // What is left, when no credit note changed what was billed (else the API knows better).
  const left =
    source.payable !== null &&
    issued.isSuccess &&
    billed.every((invoice) => invoice.creditState === 'none')
      ? subtractDecimals(source.payable, sumDecimals(billed.map((invoice) => invoice.payable)))
      : null
  // Until a choice is made: the next stage, everything (nothing billed yet) or the rest.
  const chosen: Choice | null =
    choice ??
    (!issued.isSuccess
      ? null
      : staged
        ? {
            kind: 'stage',
            stage: Math.min(
              billed.filter((invoice) => !invoice.isDeposit).length,
              source.stages.length - 1,
            ),
          }
        : { kind: 'bills', bills: nothingBilled ? 'everything' : 'rest' })
  const isPart = chosen?.kind === 'bills' && chosen.bills === 'part'
  // After a deposit invoice a part is another deposit: the final invoice bills the rest.
  const deposit = isPart && (isDeposit || deposits.length > 0)
  const read = isPart
    ? partKind === 'percent'
      ? readPercent(part)
      : readAmount(part, { positive: true, currency })
    : null
  const partProblem: I18nKey | null =
    read && !read.ok
      ? read.error.key
      : read?.ok && partKind === 'percent' && compareDecimal(read.value, '0') <= 0
        ? 'catalog.numbers.positive'
        : null
  // The part as the API works it out, against what is left (when that is known here).
  const asked: BillingPart | null =
    read?.ok && partProblem === null
      ? partKind === 'percent'
        ? { percent: read.value as Percent }
        : { amount: read.value as Money }
      : null
  const planned = asked && source.payable !== null && left !== null ? planOf(asked) : null
  const partAmount =
    planned && 'amount' in planned && partKind === 'percent' ? planned.amount : null
  const overLeft = planned && 'error' in planned ? planned.error : null

  function planOf(part: BillingPart): { amount: string } | { error: BillingCode } | null {
    try {
      const billedPayables = billed.map((invoice) => invoice.payable as Money)
      const problem = billingError(source.payable as Money, billedPayables, part, currency)
      if (problem) return { error: problem }
      return { amount: billPart(source.payable as Money, billedPayables, part, currency).amount }
    } catch {
      return null
    }
  }

  async function make() {
    setSubmitted(true)
    setError(null)
    if (!chosen || (isPart && (partProblem !== null || overLeft !== null || !read?.ok))) return
    const bill =
      chosen.kind === 'stage'
        ? { bills: 'everything' as const, part: null, isDeposit: false, stage: chosen.stage }
        : {
            bills: chosen.bills,
            part:
              chosen.bills === 'part' && read?.ok
                ? partKind === 'percent'
                  ? { percent: read.value }
                  : { amount: read.value }
                : null,
            isDeposit: chosen.bills === 'part' && deposit,
            stage: null,
          }
    try {
      const made =
        source.kind === 'quotation'
          ? await fromQuotation.mutateAsync({ id: source.id, newId: draftId, ...bill })
          : await fromOrder.mutateAsync({
              orderId: source.id,
              newId: draftId,
              bills: bill.bills,
              part: bill.part,
              isDeposit: bill.isDeposit,
            })
      await refresh()
      toast.success(t('documents.invoices.bill.made', { source: sourceName }))
      onClose()
      router.push(`/b/${businessId}/invoices/${made.id}/edit`)
    } catch (caught) {
      setError(
        apiErrorCode(caught) === 'validation'
          ? 'documents.invoices.bill.refused'
          : apiErrorKey(caught),
      )
    }
  }

  const option = (
    key: string,
    value: Choice,
    label: string,
    hint: string | null,
    extra?: React.ReactNode,
    disabled = false,
  ) => {
    const checked =
      chosen !== null &&
      chosen.kind === value.kind &&
      (chosen.kind === 'stage'
        ? chosen.stage === (value as { stage: number }).stage
        : chosen.bills === (value as { bills: InvoiceBills }).bills)
    return (
      <div
        key={key}
        className={cn(
          'rounded-xl border p-3 transition-colors',
          checked ? 'border-primary bg-primary/[0.04]' : 'bg-background/60',
          disabled && 'opacity-60',
        )}
      >
        <label
          className={cn('flex items-start gap-3', disabled ? 'cursor-default' : 'cursor-pointer')}
        >
          <input
            type="radio"
            name="invoice-bills"
            data-bills={key}
            className="mt-1 size-4 shrink-0 accent-primary"
            checked={checked}
            disabled={disabled}
            onChange={() => {
              setChoice(value)
              setError(null)
            }}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{label}</span>
            {hint ? (
              <span className="mt-0.5 block text-sm text-muted-foreground">{hint}</span>
            ) : null}
          </span>
        </label>
        {checked && extra ? <div className="mt-3 ps-7">{extra}</div> : null}
      </div>
    )
  }

  const partFields = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label={t('documents.invoices.bill.partKind')}
          value={partKind}
          onChange={(event) => {
            setPartKind(event.target.value as 'percent' | 'amount')
            setPart('')
          }}
          className="w-32 shrink-0"
        >
          <option value="percent">{t('documents.invoices.bill.percent')}</option>
          <option value="amount">{t('documents.invoices.bill.amount')}</option>
        </NativeSelect>
        {partKind === 'percent' ? (
          <Input
            id={partId}
            aria-label={t('documents.invoices.bill.partValue')}
            aria-invalid={submitted && partProblem !== null}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            data-bill-part
            placeholder="30"
            value={part}
            onChange={(event) => setPart(event.target.value)}
            onBlur={() => setPart(withLatinDigits(part))}
            className="min-w-0 flex-1"
          />
        ) : (
          <MoneyInput
            id={partId}
            label={t('documents.invoices.bill.partValue')}
            invalid={submitted && partProblem !== null}
            value={part}
            onChange={setPart}
            className="flex-1"
          />
        )}
      </div>
      {submitted && partProblem ? (
        <p role="alert" className="text-sm text-destructive">
          {t(partProblem)}
        </p>
      ) : overLeft ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`documents.invoices.bill.errors.${overLeft}`)}
        </p>
      ) : partAmount ? (
        <p data-bill-part-amount className="text-sm text-muted-foreground">
          {t('documents.invoices.bill.partIs', { amount: money(partAmount, source.currency) })}
        </p>
      ) : null}
      {deposits.length > 0 ? (
        <p className="text-sm text-muted-foreground">{t('documents.invoices.bill.depositOnly')}</p>
      ) : source.stages.length > 0 ? null : (
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            data-bill-deposit
            className="mt-0.5 size-4 shrink-0 accent-primary"
            checked={isDeposit}
            onChange={(event) => setIsDeposit(event.target.checked)}
          />
          <span>
            <span className="block font-medium">{t('documents.invoices.bill.deposit')}</span>
            <span className="block text-muted-foreground">
              {t('documents.invoices.bill.depositHint')}
            </span>
          </span>
        </label>
      )}
    </div>
  )

  const options: React.ReactNode[] = []
  if (staged) {
    // Stages are billed in their order, each once (the API refuses another): those invoiced are
    // marked, the next one is the one to choose.
    const stagesBilled = billed.filter((invoice) => !invoice.isDeposit).length
    const nameOf = (index: number) =>
      source.stages[index]?.label ?? t('documents.invoices.bill.stageName', { n: index + 1 })
    source.stages.forEach((stage, index) => {
      const last = index === source.stages.length - 1
      const percent = `${quantity(stage.percent)}%`
      const next = index === stagesBilled
      const hint =
        index < stagesBilled
          ? t('documents.invoices.bill.stageDone')
          : !next
            ? t('documents.invoices.bill.stageNext', { name: nameOf(stagesBilled) })
            : last
              ? left !== null
                ? t('documents.invoices.bill.stageAll', {
                    percent,
                    amount: money(left, source.currency),
                  })
                : t('documents.invoices.bill.stageLast', { percent })
              : t('documents.invoices.bill.stageHint', {
                  percent,
                  amount: money(stage.amount, source.currency),
                })
      options.push(
        option(
          `stage-${index}`,
          { kind: 'stage', stage: index },
          nameOf(index),
          hint,
          undefined,
          !next,
        ),
      )
    })
  }
  if (nothingBilled) {
    options.push(
      option(
        'everything',
        { kind: 'bills', bills: 'everything' },
        t('documents.invoices.bill.everything'),
        source.payable !== null
          ? t('documents.invoices.bill.everythingHint', {
              amount: money(source.payable, source.currency),
            })
          : null,
      ),
    )
  }
  if (!staged) {
    options.push(
      option(
        'part',
        { kind: 'bills', bills: 'part' },
        t('documents.invoices.bill.part'),
        t('documents.invoices.bill.partHint'),
        partFields,
      ),
    )
  }
  if (!staged && billed.length > 0) {
    options.push(
      option(
        'rest',
        { kind: 'bills', bills: 'rest' },
        deposits.length > 0
          ? t('documents.invoices.bill.restFinal')
          : t('documents.invoices.bill.rest'),
        deposits.length > 0
          ? t('documents.invoices.bill.restFinalHint')
          : left !== null
            ? t('documents.invoices.bill.restHint', { amount: money(left, source.currency) })
            : null,
      ),
    )
  }

  return (
    <ConfirmDialog
      open
      icon={ReceiptTextIcon}
      title={t('documents.invoices.bill.title', { source: sourceName })}
      body={t('documents.invoices.bill.body')}
      action={t('documents.invoices.bill.action')}
      busyLabel={t('status.saving')}
      busy={busy}
      error={error}
      disabled={chosen === null}
      onConfirm={() => void make()}
      onClose={onClose}
    >
      <div className="space-y-3">
        {billed.length > 0 ? (
          <p data-bill-billed className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
            {t('documents.invoices.bill.billed', {
              list: formatList(
                locale,
                billed.map((invoice) =>
                  isolate(`${invoice.number ?? ''} (${money(invoice.payable, invoice.currency)})`),
                ),
              ),
            })}
            {left !== null && compareDecimal(left, '0') > 0 ? (
              <span className="block text-muted-foreground">
                {t('documents.invoices.bill.left', { amount: money(left, source.currency) })}
              </span>
            ) : null}
          </p>
        ) : null}
        {issued.isPending ? (
          <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
        ) : (
          <fieldset className="min-w-0 space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {t('documents.invoices.bill.legend')}
            </legend>
            {options}
          </fieldset>
        )}
      </div>
    </ConfirmDialog>
  )
}
