'use client'

import { PAYMENT_STAGES_MAX } from '@bizcost/domain'
import { ListPlusIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { Caption, LineMessages } from '@/features/documents/line-editor'
import { newStage, type QuotationStageDraft, type StageErrors } from './quotation-draft'

// A quotation's payment terms (M3 Step 7; the owner's letterhead quotation: "1st payment upon signing
// 50%, 2nd upon delivery 35%, 3rd after handover 15%"): none, or stages that each say when and how
// much of the amount to pay (their % adding up to 100), each amount worked out (the last takes exactly
// the rest). Printed as a "Payment terms" table; Step 8's stage invoices bill them.

export function QuotationStages({
  stages,
  errors,
  rowErrors,
  shown,
  amounts,
  money,
  onChange,
}: {
  stages: readonly QuotationStageDraft[]
  errors: FieldError | undefined
  rowErrors: Record<string, StageErrors>
  shown: (error: FieldError | undefined) => string | undefined
  /** Each stage's amount, by key, when the stages read. */
  amounts: ReadonlyMap<string, string>
  money: (amount: string) => string
  onChange: (stages: QuotationStageDraft[]) => void
}) {
  const { t } = useTranslation()
  const set = (key: string, patch: Partial<QuotationStageDraft>) =>
    onChange(stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage)))

  if (stages.length === 0) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          data-stages-preset
          onClick={() =>
            onChange([
              { ...newStage('50'), due: t('documents.quotations.editor.stagePreset.signing') },
              { ...newStage('35'), due: t('documents.quotations.editor.stagePreset.delivery') },
              { ...newStage('15'), due: t('documents.quotations.editor.stagePreset.handover') },
            ])
          }
        >
          <ListPlusIcon aria-hidden />
          {t('documents.quotations.editor.stagePreset.label')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onChange([newStage('100')])}>
          <PlusIcon aria-hidden />
          {t('documents.quotations.editor.stageAdd')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {stages.map((stage, index) => {
          const rowError = rowErrors[stage.key]
          const messages = [
            shown(rowError?.label),
            shown(rowError?.due),
            shown(rowError?.percent),
          ].filter((m): m is string => Boolean(m))
          const messagesId = `stage-${stage.key}-messages`
          const amount = amounts.get(stage.key)
          return (
            <li
              key={stage.key}
              data-stage
              className="rounded-xl border bg-background/60 p-3"
              aria-describedby={messages.length > 0 ? messagesId : undefined}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                >
                  {index + 1}
                </span>
                <p className="min-w-0 flex-1 text-sm font-medium">
                  {t('documents.quotations.editor.stage', { number: index + 1 })}
                </p>
                <bdi data-stage-amount className="text-sm font-semibold tabular-nums">
                  {amount ? money(amount) : '—'}
                </bdi>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label={t('documents.quotations.editor.stageRemove', { number: index + 1 })}
                  onClick={() => onChange(stages.filter((s) => s.key !== stage.key))}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
                <div className="col-span-2 min-w-0">
                  <Caption>{t('documents.quotations.editor.stageDue')}</Caption>
                  <Input
                    aria-label={t('documents.quotations.editor.stageDue')}
                    aria-invalid={Boolean(shown(rowError?.due))}
                    autoComplete="off"
                    placeholder={t('documents.quotations.editor.stageDuePlaceholder')}
                    value={stage.due}
                    onChange={(event) => set(stage.key, { due: event.target.value })}
                    className="[unicode-bidi:plaintext]"
                  />
                </div>
                <div className="min-w-0">
                  <Caption>{t('documents.quotations.editor.stageLabel')}</Caption>
                  <Input
                    aria-label={t('documents.quotations.editor.stageLabel')}
                    aria-invalid={Boolean(shown(rowError?.label))}
                    autoComplete="off"
                    placeholder={t('documents.quotations.editor.stageLabelPlaceholder', {
                      number: index + 1,
                    })}
                    value={stage.label}
                    onChange={(event) => set(stage.key, { label: event.target.value })}
                    className="[unicode-bidi:plaintext]"
                  />
                </div>
                <div className="min-w-0">
                  <Caption>{t('documents.quotations.editor.stagePercent')}</Caption>
                  <div className="flex">
                    <Input
                      aria-label={t('documents.quotations.editor.stagePercent')}
                      aria-invalid={Boolean(shown(rowError?.percent))}
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                      value={stage.percent}
                      onChange={(event) => set(stage.key, { percent: event.target.value })}
                      onBlur={() => set(stage.key, { percent: withLatinDigits(stage.percent) })}
                      className="min-w-0 rounded-e-none tabular-nums rtl:text-end"
                    />
                    <span
                      aria-hidden
                      className="flex h-11 shrink-0 items-center rounded-e-lg border border-s-0 border-input bg-muted px-2 text-sm font-medium text-muted-foreground"
                    >
                      %
                    </span>
                  </div>
                </div>
              </div>
              <LineMessages id={messagesId} messages={messages} />
            </li>
          )
        })}
      </ol>
      {shown(errors) ? (
        <p role="alert" data-stages-error className="text-sm text-destructive">
          {shown(errors)}
        </p>
      ) : null}
      {stages.length < PAYMENT_STAGES_MAX ? (
        <Button type="button" variant="outline" onClick={() => onChange([...stages, newStage()])}>
          <PlusIcon aria-hidden />
          {t('documents.quotations.editor.stageAdd')}
        </Button>
      ) : null}
    </div>
  )
}
