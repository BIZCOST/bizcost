'use client'

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { TextField } from '@/components/form/text-field'
import { Switch } from '@/components/ui/switch'
import type { FieldError } from '@/features/catalog/numbers'
import { MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { cn } from '@/lib/utils'
import type { SaleDraft, SaleErrors } from './sale-draft'

// Delivery on One sale (M3 Step 2, D-230) and on an order (M3 Step 5): yes or no, and yes asks for
// the area, what the customer is charged (a delivery line; empty: free for them) and what it actually
// cost the business (typed by the member who enters it, or with the costs switch).

type DeliveryDraft = Pick<
  SaleDraft,
  'deliveryNeeded' | 'deliveryArea' | 'deliveryCharged' | 'deliveryIncludesVat' | 'deliveryCost'
>

export function DeliveryFields({
  draft,
  errors,
  shown,
  vatRegistered,
  costShown,
  question,
  onChange,
}: {
  draft: DeliveryDraft
  errors: Pick<SaleErrors, 'deliveryArea' | 'deliveryCharged' | 'deliveryCost'>
  shown: (error: FieldError | undefined) => string | undefined
  vatRegistered: boolean
  /** The member types what the delivery cost here. */
  costShown: boolean
  /** "Was it delivered?" (a sale) or "Will you deliver it?" (an order). */
  question: string
  onChange: (patch: Partial<DeliveryDraft>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <Panel title={t('sales.editor.delivery')}>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{question}</legend>
        <div className="grid max-w-xs grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          {[false, true].map((needed) => (
            <label key={String(needed)} className="relative min-w-0">
              <input
                type="radio"
                name={`${id}-needed`}
                value={needed ? 'yes' : 'no'}
                checked={draft.deliveryNeeded === needed}
                onChange={() => onChange({ deliveryNeeded: needed })}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors',
                  'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                  'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                )}
              >
                {needed ? t('sales.editor.deliveryYes') : t('sales.editor.deliveryNo')}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {draft.deliveryNeeded ? (
        <div data-delivery className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('sales.editor.deliveryArea')}
            autoComplete="off"
            className="[unicode-bidi:plaintext]"
            placeholder={t('sales.editor.deliveryAreaPlaceholder')}
            value={draft.deliveryArea}
            onChange={(event) => onChange({ deliveryArea: event.target.value })}
            error={shown(errors.deliveryArea)}
          />
          <TextField
            label={t('sales.editor.deliveryCharged')}
            error={shown(errors.deliveryCharged)}
            hint={(hintId) => (
              <p id={hintId} className="text-sm text-muted-foreground">
                {t('sales.editor.deliveryChargedHint')}
              </p>
            )}
            render={(a11y) => (
              <MoneyInput
                id={a11y.id}
                invalid={a11y['aria-invalid']}
                describedBy={a11y['aria-describedby']}
                value={draft.deliveryCharged}
                onChange={(deliveryCharged) => onChange({ deliveryCharged })}
              />
            )}
          />
          {vatRegistered ? (
            <div className="flex items-center justify-between gap-4 sm:col-start-2">
              <label htmlFor={`${id}-vat`} className="text-sm">
                {t('sales.editor.deliveryIncludesVat')}
              </label>
              <Switch
                id={`${id}-vat`}
                checked={draft.deliveryIncludesVat}
                onCheckedChange={(deliveryIncludesVat) => onChange({ deliveryIncludesVat })}
              />
            </div>
          ) : null}
          {costShown ? (
            <TextField
              label={t('sales.editor.deliveryCost')}
              error={shown(errors.deliveryCost)}
              hint={(hintId) => (
                <p id={hintId} className="text-sm text-muted-foreground">
                  {t('sales.editor.deliveryCostHint')}
                </p>
              )}
              render={(a11y) => (
                <MoneyInput
                  id={a11y.id}
                  invalid={a11y['aria-invalid']}
                  describedBy={a11y['aria-describedby']}
                  value={draft.deliveryCost}
                  onChange={(deliveryCost) => onChange({ deliveryCost })}
                />
              )}
            />
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}
