'use client'

import { compareDecimal } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { ltrIsolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Caption, DiscountRow, MoneyInput } from '@/features/documents/line-editor'
import type { DiscountKind } from '@/features/documents/lines'
import { QuotationTotals } from './quotation-totals'
import type { Rounding } from './quotation-draft'
import type { QuotationTotalsValues } from './totals'

// A document's discount on the whole of it, "Round the total" («تقريب الإجمالي», D-221) and its
// totals in its editor (M3 Step 7; shared with the invoice made from scratch, M3 Step 8): type 1,100
// and see the adjustment before VAT and any rounding difference as the PDF prints them; a rounded total
// kept while the lines change is said, with "Keep" and "Take the rounding off" (D-297).

export function TotalsEditor({
  discountKind,
  discount,
  roundTo,
  discountError,
  roundToError,
  rounding,
  stale,
  carried,
  vatRegistered,
  totals,
  money,
  onDiscount,
  onRoundTo,
  onKeep,
  discountLabel,
  addDiscountLabel,
}: {
  discountKind: DiscountKind
  discount: string
  roundTo: string
  /** The problems as shown (translated), if any. */
  discountError: string | undefined
  roundToError: string | undefined
  rounding: Rounding | null
  /** The lines changed since the total was rounded (or it came rounded: `carried`). */
  stale: boolean
  /** Where a total that came rounded was rounded (null: here, once the amounts changed). */
  carried: 'revision' | 'copy' | null
  vatRegistered: boolean
  totals: QuotationTotalsValues
  money: (amount: string) => string
  onDiscount: (next: { kind: DiscountKind; value: string }) => void
  onRoundTo: (roundTo: string) => void
  /** "Keep 15,000.00": the rounded total stays on the lines as they are now. */
  onKeep: () => void
  /** "Discount on the whole quotation" (an invoice says its own). */
  discountLabel?: string
  addDiscountLabel?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div data-quotation-discount>
        <DiscountRow
          kind={discountKind}
          value={discount}
          invalid={Boolean(discountError)}
          addLabel={addDiscountLabel ?? t('documents.quotations.editor.addDiscount')}
          label={discountLabel ?? t('documents.quotations.editor.discount')}
          onChange={onDiscount}
        />
        {discountError ? (
          <p role="alert" className="mt-1.5 text-sm text-destructive">
            {discountError}
          </p>
        ) : null}
      </div>
      <div data-round-total>
        <Caption>{t('documents.quotations.editor.roundTo')}</Caption>
        <MoneyInput
          label={t('documents.quotations.editor.roundTo')}
          value={roundTo}
          invalid={Boolean(roundToError)}
          onChange={onRoundTo}
        />
        {stale && rounding ? (
          <div
            data-rounding-stale
            role="status"
            className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-800"
          >
            <p className="font-medium">
              {t('documents.quotations.editor.roundStaleTitle', {
                total: ltrIsolate(money(rounding.wanted)),
              })}
            </p>
            <p className="mt-1">
              {t(
                carried === 'copy'
                  ? 'documents.quotations.editor.roundCarriedCopy'
                  : carried === 'revision'
                    ? 'documents.quotations.editor.roundCarried'
                    : 'documents.quotations.editor.roundStale',
                { amount: ltrIsolate(money(rounding.adjustment)) },
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={onKeep}>
                {t('documents.quotations.editor.roundKeep', {
                  total: ltrIsolate(money(rounding.wanted)),
                })}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onRoundTo('')}>
                {t('documents.quotations.editor.roundRemove')}
              </Button>
            </div>
          </div>
        ) : null}
        {roundToError ? (
          <p role="alert" className="mt-1.5 text-sm text-destructive">
            {roundToError}
          </p>
        ) : rounding ? (
          <div data-rounding className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
            <p>
              {t(
                vatRegistered
                  ? 'documents.quotations.editor.roundAdjustment'
                  : 'documents.quotations.editor.roundAdjustmentNoVat',
                { amount: ltrIsolate(money(rounding.adjustment)) },
              )}
            </p>
            {compareDecimal(rounding.difference, '0') !== 0 ? (
              <p>
                {t('documents.quotations.editor.roundDifference', {
                  amount: ltrIsolate(money(rounding.difference)),
                })}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(
              vatRegistered
                ? 'documents.quotations.editor.roundHint'
                : 'documents.quotations.editor.roundHintNoVat',
            )}
          </p>
        )}
      </div>
      <div className="border-t pt-3">
        <QuotationTotals values={totals} vatRegistered={vatRegistered} money={money} />
      </div>
    </div>
  )
}
