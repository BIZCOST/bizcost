'use client'

import type { DiscountDto } from '@bizcost/contracts'
import { compareDecimal, subtractDecimals, type StandardUnit } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { useMoney } from '@/features/documents/amounts'
import { cn } from '@/lib/utils'

// A document's lines as they are (a quotation, M3 Step 7; an invoice, M3 Step 8): by area, as the PDF
// groups them, each with its number, picture, title, details, red note, quantity × price, discount
// and amount ("Before VAT", or "incl. VAT" when its price includes VAT, D-296). A final invoice's
// deposit taken off (a deduction) shows its own words and its amount below zero.

/** What a shown line needs (QuotationLineDto and InvoiceLineDto both have it). */
export interface ShownLine {
  readonly id: string
  /** An invoice's line kind ('deduction': a deposit invoice taken off); absent on a quotation. */
  readonly kind?: 'item' | 'delivery' | 'deduction'
  readonly area: string | null
  readonly description: string
  readonly details: string | null
  readonly note: string | null
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly unitPrice: string
  readonly priceIncludesVat: boolean
  readonly discount: DiscountDto | null
  readonly vatRate: string | null
  readonly subtotal: string
  readonly lineDiscount: string
  readonly typed: boolean
  readonly picture: { readonly url: string | null } | null
}

/** Consecutive lines of one area (or of none), as the PDF groups them. */
function groupsOf<T extends ShownLine>(lines: readonly T[]) {
  const groups: { area: string | null; lines: T[] }[] = []
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
  typedLabel,
}: {
  line: ShownLine
  number: number
  currency: string
  vat: boolean
  typedLabel?: string | null
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const unitQuantity = useUnitQuantity()
  const amount = subtractDecimals(line.subtotal, line.lineDiscount)
  const picture = Boolean(line.picture?.url)
  const deduction = line.kind === 'deduction'
  // A phone gives the text the width: the amount goes under it and the picture is smaller; from md
  // the amount sits beside the text (D-297).
  return (
    <li
      data-quotation-line
      data-line-kind={line.kind}
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
        {deduction ? null : (
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
            {line.typed && typedLabel !== null ? (
              <> · {typedLabel ?? t('documents.quotations.view.typed')}</>
            ) : null}
          </p>
        )}
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

/** The lines grouped by area, numbered across the areas. */
export function DocumentLineList({
  lines,
  currency,
  vat,
  typedLabel,
}: {
  lines: readonly ShownLine[]
  currency: string
  /** VAT-registered: each amount says before VAT or with it. */
  vat: boolean
  /** "Typed on this quotation" (an invoice says its own; null: not said). */
  typedLabel?: string | null
}) {
  const { t } = useTranslation()
  const groups = groupsOf(lines)
  const hasAreas = groups.some((group) => group.area !== null)
  let counter = 0
  return (
    <div className="space-y-4">
      {groups.map((group, index) => (
        <section
          key={`${group.area ?? ''}-${index}`}
          aria-label={
            group.area ?? (hasAreas ? t('documents.quotations.editor.areas.none') : undefined)
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
                {t('documents.quotations.editor.areas.count', { count: group.lines.length })}
              </span>
            </div>
          ) : hasAreas ? (
            // Lines without an area among areas: a heading of their own, so they never read as
            // more lines of the area before them.
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 border-s-4 border-muted-foreground/30 ps-2">
              <h3 data-no-area className="text-sm font-semibold text-muted-foreground">
                {t('documents.quotations.editor.areas.none')}
              </h3>
              <span className="text-xs text-muted-foreground">
                {t('documents.quotations.editor.areas.count', { count: group.lines.length })}
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
                  currency={currency}
                  vat={vat}
                  typedLabel={typedLabel}
                />
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
