'use client'

import type { InvoiceDto, InvoiceLineDto } from '@bizcost/contracts'
import { printedVatColumn } from '@bizcost/domain'
import { currencyDigits, formatDecimal } from '@bizcost/i18n'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormatQuantity, useUnitQuantity } from '@/features/catalog/unit-parts'
import { decimalPlaces } from '@/features/catalog/units'
import { LineGroups } from '@/features/quotations/document-line-list'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { invoiceLineRow } from './invoice-line-rows'

// An invoice's lines on its page, with the columns of its PDF (D-360; the owner's request of 2026-11-04):
// Unit price | Qty | Discount | Before VAT | VAT 5% | Total, and Unit price | Qty | Discount | Total
// without VAT. In a wide panel they are one table with one heading; in a narrow one (a phone, a laptop
// beside the totals) each line has its description, then its amounts each under its own label.

// From a panel 40 rem wide the amounts sit in columns under one heading.
const TAX_ROW =
  'grid-cols-[1.25rem_minmax(0,1fr)] @min-[40rem]:grid-cols-[1.5rem_minmax(0,2.4fr)_repeat(6,minmax(0,1fr))]'
const PLAIN_ROW =
  'grid-cols-[1.25rem_minmax(0,1fr)] @min-[40rem]:grid-cols-[1.5rem_minmax(0,3fr)_repeat(4,minmax(0,1fr))]'

function Amount({
  label,
  name,
  strong,
  faint,
  children,
}: {
  label: string
  name: string
  strong?: boolean
  faint?: boolean
  children: ReactNode
}) {
  return (
    <div className="min-w-0 text-start @min-[40rem]:text-end">
      <dt className="text-xs text-muted-foreground @min-[40rem]:sr-only">{label}</dt>
      <dd
        data-invoice-amount={name}
        className={cn(
          'text-sm tabular-nums [overflow-wrap:anywhere]',
          strong && 'font-semibold',
          faint && 'text-muted-foreground',
        )}
      >
        {children}
      </dd>
    </div>
  )
}

export function InvoiceLines({
  invoice,
  typedLabel,
}: {
  invoice: Pick<InvoiceDto, 'kind' | 'currency' | 'lines'>
  /** "Typed on this invoice"; null: not said. */
  typedLabel: string | null
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const unitQuantity = useUnitQuantity()
  const formatQuantity = useFormatQuantity()
  const tax = invoice.kind === 'tax_invoice'
  const digits = currencyDigits(invoice.currency)
  /** A number that may break after a thousands comma in a narrow column, never inside its fils. */
  const grouped = (text: string) =>
    text.split(',').map((group, i, groups) =>
      i === groups.length - 1 ? (
        group
      ) : (
        <Fragment key={i}>
          {group},<wbr />
        </Fragment>
      ),
    )
  /** An amount without its currency (the note above says it), with at least the currency's digits. */
  const amount = (value: string) => (
    <bdi dir="ltr">
      {grouped(formatDecimal(locale, value, Math.max(digits, decimalPlaces(value))))}
    </bdi>
  )
  const column = tax ? printedVatColumn(invoice.lines) : null
  const mixed = column?.kind === 'mixed'
  const vatHead =
    column?.kind !== 'one'
      ? t('documents.pdf.table.vatHead.mixed')
      : column.vatCategory === 'exempt'
        ? t('documents.pdf.table.vatHead.exempt')
        : t('documents.pdf.table.vatHead.rate', { rate: formatQuantity(column.vatRate) })
  const rateOf = (line: InvoiceLineDto) =>
    line.vatCategory === 'exempt'
      ? t('documents.pdf.vatCategory.exempt')
      : line.vatCategory === 'zero_rated'
        ? t('documents.pdf.vatCategory.zeroRated')
        : `${formatQuantity(line.vatRate ?? '0')}%`
  const heads = [
    t('documents.pdf.table.unitPrice'),
    t('documents.pdf.table.qty'),
    t('documents.pdf.table.discount'),
    ...(tax ? [t('documents.pdf.table.beforeVat'), vatHead] : []),
    t('documents.pdf.table.total'),
  ]
  const grid = tax ? TAX_ROW : PLAIN_ROW
  return (
    <div data-invoice-lines className="@container">
      <p className="mb-3 text-xs text-muted-foreground">
        {invoice.currency === 'AED'
          ? t('documents.pdf.amountsInAed')
          : t('documents.pdf.amountsIn', { currency: invoice.currency })}
      </p>
      <div
        aria-hidden
        className={cn(
          'mb-1 hidden gap-x-2 border-b pb-2 text-xs font-medium text-muted-foreground @min-[40rem]:grid',
          grid,
        )}
      >
        <span>{t('documents.pdf.table.no')}</span>
        <span>{t('documents.pdf.table.description')}</span>
        {heads.map((head) => (
          <span key={head} className="min-w-0 text-end">
            <bdi>{head}</bdi>
          </span>
        ))}
      </div>
      <LineGroups lines={invoice.lines}>
        {(line, number) => {
          const row = invoiceLineRow(line, invoice.currency)
          const quantity = line.unit ? unitQuantity(row.qty, line.unit) : formatQuantity(row.qty)
          return (
            <li
              key={line.id}
              data-quotation-line
              data-line-kind={line.kind}
              className={cn(
                'grid items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0 @min-[40rem]:gap-x-2',
                grid,
              )}
            >
              <span className="mt-0.5 text-sm text-muted-foreground tabular-nums">{number}</span>
              <div className="flex min-w-0 gap-3 @min-[40rem]:flex-col @min-[40rem]:gap-1.5">
                {line.picture?.url ? (
                  // A signed URL of the business's private bucket: a plain image.
                  <img
                    src={line.picture.url}
                    alt={t('documents.quotations.editor.pictureAlt')}
                    data-line-picture
                    className="h-12 w-16 shrink-0 rounded-lg border object-cover"
                  />
                ) : null}
                <div className="min-w-0">
                  <p className="text-start font-medium break-words">
                    <bdi>{line.description}</bdi>
                  </p>
                  {line.details ? (
                    <p
                      dir="auto"
                      className="mt-0.5 text-sm whitespace-pre-line text-muted-foreground"
                    >
                      {line.details}
                    </p>
                  ) : null}
                  {line.note ? (
                    <p
                      dir="auto"
                      className="mt-0.5 text-sm font-medium whitespace-pre-line text-destructive"
                    >
                      {line.note}
                    </p>
                  ) : null}
                  {line.typed && typedLabel !== null ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{typedLabel}</p>
                  ) : null}
                </div>
              </div>
              <dl
                className={cn(
                  'col-start-2 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 @min-[40rem]:col-start-auto @min-[40rem]:grid-cols-subgrid @min-[40rem]:gap-x-2',
                  tax
                    ? '@min-[28rem]:grid-cols-3 @min-[32rem]:grid-cols-6 @min-[40rem]:col-span-6'
                    : '@min-[28rem]:grid-cols-4 @min-[40rem]:col-span-4',
                )}
              >
                <Amount label={t('documents.pdf.table.unitPrice')} name="unitPrice">
                  {amount(row.unitPrice)}
                  {row.includesVat ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t('documents.pdf.table.inclVat')}
                    </span>
                  ) : null}
                </Amount>
                <Amount label={t('documents.pdf.table.qty')} name="qty">
                  {/* A plain space: too narrow for both, the unit goes under its number, whole. */}
                  <bdi>{grouped(quantity)}</bdi>
                </Amount>
                <Amount label={t('documents.pdf.table.discount')} name="discount" faint>
                  {amount(row.discount)}
                </Amount>
                {tax ? (
                  <>
                    <Amount label={t('documents.pdf.table.beforeVat')} name="beforeVat">
                      {amount(row.beforeVat)}
                    </Amount>
                    <Amount label={vatHead} name="vat">
                      {amount(row.vat)}
                      {mixed ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          <bdi>{rateOf(line)}</bdi>
                        </span>
                      ) : null}
                    </Amount>
                  </>
                ) : null}
                <Amount label={t('documents.pdf.table.total')} name="total" strong>
                  {amount(row.total)}
                </Amount>
              </dl>
            </li>
          )
        }}
      </LineGroups>
    </div>
  )
}
