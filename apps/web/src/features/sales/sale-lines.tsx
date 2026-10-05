'use client'

import type { ProductDto } from '@bizcost/contracts'
import { compareDecimal, type SaleLineAmounts } from '@bizcost/domain'
import { Trash2Icon } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useMoney } from '@/features/documents/amounts'
import { Caption, DiscountRow, LineMessages, MoneyInput } from '@/features/documents/line-editor'
import { NamePicker } from '@/features/documents/name-picker'
import { cn } from '@/lib/utils'
import type { ItemLineDraft, ItemLineErrors } from './sale-draft'

// The lines of One sale (M3 Step 2): a product or service typed and picked from a list that can add a
// new one (the line's quick-add opens the product form, as a purchase line's material, D-233), how
// many, its price (filled in from the usual price; for a VAT-registered business the caption says
// whether it is before VAT or includes it, as the product says, D-121) and an optional discount.

/** A line: the product or service, how many, the price and a discount, and what it comes to. */
export function ItemLineRow({
  index,
  line,
  products,
  pickable,
  errors,
  shown,
  amounts,
  vatRegistered,
  addLabel,
  onChange,
  onRemove,
  onAdd,
}: {
  index: number
  line: ItemLineDraft
  products: ReadonlyMap<string, ProductDto>
  /** What the picker offers (active products and services, and the line's own). */
  pickable: readonly ProductDto[]
  errors: ItemLineErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  amounts: SaleLineAmounts | undefined
  vatRegistered: boolean
  /** "Add «name» as a new product or service", in the business's wording. */
  addLabel: (name: string) => string
  onChange: (line: ItemLineDraft) => void
  onRemove: (() => void) | undefined
  /** Opens the product form for a name typed in the picker (absent: may not add one). */
  onAdd?: (name: string) => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const messagesId = useId()
  const product = line.productId ? products.get(line.productId) : undefined
  const messages = [
    shown(errors?.item),
    shown(errors?.qty),
    shown(errors?.price),
    shown(errors?.discount),
  ].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? messagesId : undefined
  const priceLabel = !vatRegistered
    ? t('sales.editor.price')
    : product?.priceIncludesVat
      ? t('sales.editor.priceInclVat')
      : t('sales.editor.priceBeforeVat')

  function pick(next: ProductDto) {
    onChange({
      ...line,
      productId: next.id,
      // A new pick takes its usual price; a price already typed for it stays.
      price: next.id === line.productId ? line.price : (next.defaultPrice ?? ''),
    })
  }

  return (
    <fieldset
      data-sale-line
      className="rounded-xl border bg-background/60 p-3 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1.6fr)_2.75rem] lg:items-end lg:gap-x-3 lg:gap-y-1.5"
    >
      <legend className="sr-only">{t('sales.editor.line', { number: index + 1 })}</legend>
      <div className="flex items-end gap-2 lg:contents">
        <div className="min-w-0 flex-1 lg:col-start-1 lg:row-start-1">
          <Caption>{t('sales.editor.item')}</Caption>
          <NamePicker
            label={t('sales.editor.item')}
            value={line.productId}
            items={products}
            pickable={pickable}
            placeholder={product || !line.savedName ? t('sales.editor.pick') : line.savedName}
            invalid={Boolean(shown(errors?.item))}
            describedBy={describedBy}
            addLabel={addLabel}
            onPick={pick}
            onAdd={onAdd}
          />
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('sales.editor.removeLine')}
            onClick={onRemove}
            className="shrink-0 text-muted-foreground lg:row-start-1 lg:[grid-column:-2]"
          >
            <Trash2Icon aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 lg:contents">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <Caption>{t('sales.editor.qty')}</Caption>
          <Input
            aria-label={t('sales.editor.qty')}
            aria-invalid={Boolean(shown(errors?.qty))}
            aria-describedby={describedBy}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={line.qty}
            onChange={(event) => onChange({ ...line, qty: event.target.value })}
            onBlur={() => onChange({ ...line, qty: withLatinDigits(line.qty) })}
            className="tabular-nums rtl:text-end"
          />
        </div>
        <div className="min-w-0 lg:col-start-3 lg:row-start-1">
          <Caption>{priceLabel}</Caption>
          <MoneyInput
            label={priceLabel}
            value={line.price}
            invalid={Boolean(shown(errors?.price))}
            describedBy={describedBy}
            onChange={(price) => onChange({ ...line, price })}
          />
        </div>
      </div>
      <DiscountRow
        kind={line.discountKind}
        value={line.discount}
        invalid={Boolean(shown(errors?.discount))}
        describedBy={describedBy}
        addLabel={t('purchasing.editor.addDiscount')}
        label={t('purchasing.editor.lineDiscount')}
        onChange={(next) => onChange({ ...line, discountKind: next.kind, discount: next.value })}
        className="mt-1 lg:row-start-2 lg:[grid-column:1/3]"
      />
      <LineMessages
        id={messagesId}
        messages={messages}
        className="lg:row-start-3 lg:[grid-column:1/-1]"
      />
      {amounts ? (
        <p
          className={cn(
            'mt-2 flex flex-wrap items-baseline justify-end gap-x-3 border-t pt-2 text-sm',
            'lg:row-start-2 lg:mt-0 lg:self-center lg:border-t-0 lg:pt-0 lg:[grid-column:3/-1]',
          )}
        >
          {vatRegistered && compareDecimal(amounts.vat, '0') > 0 ? (
            <span className="text-muted-foreground">
              {t('sales.editor.lineVat', { amount: money(amounts.vat) })}
            </span>
          ) : null}
          <span data-line-total className="font-medium">
            {t('sales.editor.lineTotal', { amount: money(amounts.total) })}
          </span>
        </p>
      ) : null}
    </fieldset>
  )
}
