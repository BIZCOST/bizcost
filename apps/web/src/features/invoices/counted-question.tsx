'use client'

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

// "Is this sale already in your recorded sales (Today's sales, an import or your POS)?" (M3 Step 8; Q3:
// each sale counts once): asked of an invoice made from scratch (or from a quotation) when the business
// records its sales otherwise too, and of a credit note on an invoice answered "yes". Required before
// the issue and never preselected: Yes, it isn't counted again; No, it counts with the document.

export function CountedQuestion({
  value,
  credit = false,
  error,
  onChange,
}: {
  value: '' | 'yes' | 'no'
  /** A credit note's question (a refund already in the recorded sales). */
  credit?: boolean
  /** Shown once the person tried to go on without an answer. */
  error?: string
  onChange: (value: 'yes' | 'no') => void
}) {
  const { t } = useTranslation()
  const name = useId()
  const errorId = `${name}-error`
  const words = credit ? 'documents.invoices.credit.counted' : 'documents.invoices.counted'
  return (
    <fieldset
      data-counted-question
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
      className={cn(
        'min-w-0 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5',
        error && 'ring-destructive/50',
      )}
    >
      <legend className="sr-only">{t(`${words}.question`)}</legend>
      <p aria-hidden className="font-semibold">
        {t(`${words}.question`)}
      </p>
      <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t(`${words}.why`)}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(['yes', 'no'] as const).map((answer) => (
          <label
            key={answer}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors',
              value === answer ? 'border-primary bg-primary/[0.04]' : 'bg-background/60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={answer}
              data-counted={answer}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={value === answer}
              onChange={() => onChange(answer)}
            />
            <span className="min-w-0">
              <span className="block font-medium">{t(`${words}.${answer}`)}</span>
              <span className="block text-muted-foreground">{t(`${words}.${answer}Hint`)}</span>
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}
