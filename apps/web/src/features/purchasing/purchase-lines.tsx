'use client'

import type { MaterialDto } from '@bizcost/contracts'
import {
  compareDecimal,
  type PurchaseLineAmounts,
  type Quantity,
  type TerminologyProfile,
} from '@bizcost/domain'
import { currencySymbol } from '@bizcost/i18n'
import { PercentIcon, PlusIcon, Trash2Icon, TruckIcon, XIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  readAmount,
  readQuantity,
  withLatinDigits,
  type FieldError,
} from '@/features/catalog/numbers'
import { PackChainText, useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP, UNITS_BY_DIMENSION } from '@/features/catalog/units'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { useMoney, useUnitCost } from './amounts'
import { MaterialPicker } from './material-picker'
import {
  defaultUnitOf,
  dimensionsOf,
  isUnitOf,
  pricePerCountingUnit,
  quantityInWords,
  unitRefOf,
  type LineUnit,
} from './line-units'
import {
  NO_VAT,
  STANDARD_VAT_RATE,
  type DeliveryLineDraft,
  type DiscountKind,
  type LineErrors,
  type MaterialLineDraft,
} from './purchase-draft'

// The lines of the purchase editor (M2 Step 3): a material bought in any unit of its kind of measure
// or one of its packs, said in words as it is typed ("2 bags = 2 kg"), its price per the unit chosen
// and what that makes per the unit it is counted in, an optional discount and, for a VAT-registered
// business, its VAT; and delivery charged on the same invoice. The material is typed and picked from
// a list that can add a new one (the owner's request of 2026-09-29); for a VAT-registered business
// the price's caption says whether it is before VAT or includes it, as the purchase says.

/** A small caption over a box (the box has its own accessible name). */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="mb-1 block text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

/** A money box: the currency before the typed amount, as the lists write it. */
export function MoneyInput({
  value,
  onChange,
  invalid,
  describedBy,
  label,
  id,
  className,
}: {
  value: string
  onChange: (value: string) => void
  invalid: boolean
  describedBy?: string
  /** The box's accessible name (without an `id` a visible label points to). */
  label?: string
  id?: string
  className?: string
}) {
  const { locale } = useLocale()
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  return (
    <div className={cn('flex min-w-0', className)}>
      <span
        aria-hidden
        className="flex h-11 shrink-0 items-center rounded-s-lg border border-e-0 border-input bg-muted px-2.5 text-sm font-medium text-muted-foreground"
      >
        {currencySymbol(locale, context?.currency ?? 'AED')}
      </span>
      <Input
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        inputMode="decimal"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('purchasing.editor.amountPlaceholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onChange(withLatinDigits(value))}
        className="min-w-0 rounded-s-none tabular-nums rtl:text-end"
      />
    </div>
  )
}

/** A line's messages, under it, read out when they change. */
function LineMessages({
  id,
  messages,
  className,
}: {
  id: string
  messages: readonly string[]
  className?: string
}) {
  if (messages.length === 0) return null
  return (
    <div id={id} role="alert" className={cn('mt-2 space-y-1 text-sm text-destructive', className)}>
      {/* The same words for two boxes ("Enter a number.") are said once; the boxes are marked. */}
      {[...new Set(messages)].map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  )
}

/**
 * The VAT of a line: the standard rate or none (a stored other rate stays offered). The options are
 * short ("5%", "None"): the caption and the box's name say VAT, and a phone has no room for more.
 */
function VatSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation()
  const rates = [STANDARD_VAT_RATE, NO_VAT]
  return (
    <NativeSelect
      aria-label={t('purchasing.editor.vat')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {!rates.includes(value) ? (
        <option value={value}>{t('purchasing.editor.vatOption', { rate: value })}</option>
      ) : null}
      <option value={STANDARD_VAT_RATE}>
        {t('purchasing.editor.vatOption', { rate: STANDARD_VAT_RATE })}
      </option>
      <option value={NO_VAT}>{t('purchasing.editor.vatOptionNone')}</option>
    </NativeSelect>
  )
}

/**
 * A discount: a button to add one, or its caption over its kind (percentage or amount), its box
 * and ×.
 */
export function DiscountRow({
  kind,
  value,
  onChange,
  invalid,
  describedBy,
  addLabel,
  label,
  className,
}: {
  kind: DiscountKind
  value: string
  onChange: (next: { kind: DiscountKind; value: string }) => void
  invalid: boolean
  describedBy?: string
  addLabel: string
  /** The caption over it and the box's accessible name. */
  label: string
  className?: string
}) {
  const { t } = useTranslation()
  if (kind === 'none') {
    return (
      <Button
        type="button"
        variant="link"
        className={cn('h-9 justify-start justify-self-start px-0', className)}
        onClick={() => onChange({ kind: 'percent', value: '' })}
      >
        <PercentIcon aria-hidden />
        {addLabel}
      </Button>
    )
  }
  return (
    <div className={cn('min-w-0', className)}>
      <Caption>{label}</Caption>
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label={t('purchasing.editor.discountKind')}
          value={kind}
          onChange={(event) => onChange({ kind: event.target.value as DiscountKind, value })}
          className="w-28 shrink-0"
        >
          <option value="percent">{t('purchasing.editor.discountPercent')}</option>
          <option value="amount">{t('purchasing.editor.discountAmount')}</option>
        </NativeSelect>
        {kind === 'percent' ? (
          <div className="flex min-w-0 flex-1">
            <Input
              aria-label={label}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('purchasing.editor.percentPlaceholder')}
              value={value}
              onChange={(event) => onChange({ kind, value: event.target.value })}
              onBlur={() => onChange({ kind, value: withLatinDigits(value) })}
              className="min-w-0 rounded-e-none tabular-nums rtl:text-end"
            />
            <span
              aria-hidden
              className="flex h-11 shrink-0 items-center rounded-e-lg border border-s-0 border-input bg-muted px-2.5 text-sm font-medium text-muted-foreground"
            >
              %
            </span>
          </div>
        ) : (
          <MoneyInput
            label={label}
            value={value}
            invalid={invalid}
            describedBy={describedBy}
            onChange={(next) => onChange({ kind, value: next })}
            className="flex-1"
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('purchasing.editor.removeDiscount')}
          onClick={() => onChange({ kind: 'none', value: '' })}
          className="shrink-0 text-muted-foreground"
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    </div>
  )
}

/** What a unit is called after "per": a pack's name, or the unit's short name. */
function unitNameOf(
  material: MaterialDto | undefined,
  unit: LineUnit,
  short: (unit: string) => string,
): string | null {
  const ref = unitRefOf(unit)
  if (!ref || !material) return null
  if (typeof ref === 'string') return short(ref)
  return material.packs.find((pack) => pack.id === ref.pack)?.name ?? null
}

/**
 * From lg up (a desktop) each line is one row, its columns aligned with the other lines': material |
 * quantity | unit | price | VAT | ×, with the words, the hint, the discount and the total under them.
 * On a phone the same boxes stack (the wrappers below are `lg:contents`, so their boxes join this
 * grid on a desktop).
 */
function lineGrid(vatRegistered: boolean) {
  return cn(
    'lg:grid lg:items-end lg:gap-x-3 lg:gap-y-1.5',
    vatRegistered
      ? 'lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_2.75rem]'
      : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,2fr)_2.75rem]',
  )
}

/** A material line: the material, how many in which unit, the price, a discount and the VAT. */
export function MaterialLineRow({
  index,
  line,
  materials,
  pickable,
  errors,
  shown,
  amounts,
  vatRegistered,
  pricesIncludeVat,
  profile,
  onChange,
  onRemove,
  onAddMaterial,
}: {
  index: number
  line: MaterialLineDraft
  materials: ReadonlyMap<string, MaterialDto>
  /** The materials the picker offers (active ones, and the line's own). */
  pickable: readonly MaterialDto[]
  errors: LineErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  amounts: PurchaseLineAmounts | undefined
  vatRegistered: boolean
  /** The purchase's prices are typed with their VAT (VAT-registered businesses). */
  pricesIncludeVat: boolean
  profile: TerminologyProfile
  onChange: (line: MaterialLineDraft) => void
  onRemove: (() => void) | undefined
  /** Opens the quick-add sheet for a name typed in the picker (absent: may not add). */
  onAddMaterial?: (name: string) => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const unitCost = useUnitCost()
  const unitQuantity = useUnitQuantity()
  const messagesId = useId()
  const material = line.materialId ? materials.get(line.materialId) : undefined
  const messages = [
    shown(errors?.material),
    shown(errors?.qty),
    shown(errors?.unit),
    shown(errors?.price),
    shown(errors?.discount),
  ].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? messagesId : undefined
  const ref = unitRefOf(line.unit)
  const qty = readQuantity(line.qty)
  const price = readAmount(line.price)
  const validUnit = material !== undefined && isUnitOf(material, line.unit)

  // "2 bags = 2 kg" once the quantity reads, and "AED 45.00 per kg" once the price does too.
  let words: ReactNode = null
  let perUnit: string | null = null
  if (material && ref && validUnit) {
    const steps = qty.ok ? quantityInWords(material, qty.value as Quantity, ref) : null
    if (steps && steps.length > 0) words = <PackChainText steps={steps} />
    if (price.ok && (typeof ref !== 'string' || ref !== material.unit)) {
      const per = pricePerCountingUnit(material, price.value, '1' as Quantity, ref)
      if (per) perUnit = `${unitCost(per)}${NBSP}${t(`units.per.${material.unit}`)}`
    }
  }
  const name = unitNameOf(material, line.unit, (unit) => t(`units.short.${unit as 'kg'}`))
  // Per the unit chosen ("Price per bag") and, for a VAT-registered business, before VAT or with it
  // as the purchase says ("Price per bag incl. VAT").
  const priceLabel = !vatRegistered
    ? name
      ? t('purchasing.editor.pricePer', { unit: name })
      : t('purchasing.editor.price')
    : name
      ? pricesIncludeVat
        ? t('purchasing.editor.pricePerInclVat', { unit: name })
        : t('purchasing.editor.pricePerBeforeVat', { unit: name })
      : pricesIncludeVat
        ? t('purchasing.editor.priceInclVat')
        : t('purchasing.editor.priceBeforeVat')

  function pickMaterial(next: MaterialDto) {
    onChange({
      ...line,
      materialId: next.id,
      unit: isUnitOf(next, line.unit) ? line.unit : defaultUnitOf(next),
      savedName: null,
    })
  }

  return (
    <fieldset
      data-line-row
      className={cn('rounded-xl border bg-background/60 p-3', lineGrid(vatRegistered))}
    >
      <legend className="sr-only">{t('purchasing.editor.line', { number: index + 1 })}</legend>
      <div className="flex items-end gap-2 lg:contents">
        <div className="min-w-0 flex-1 lg:col-start-1 lg:row-start-1">
          <Caption>{term('purchasing.editor.material', profile)}</Caption>
          <MaterialPicker
            label={term('purchasing.editor.material', profile)}
            value={line.materialId}
            materials={materials}
            pickable={pickable}
            placeholder={
              material || !line.savedName ? t('purchasing.editor.pickMaterial') : line.savedName
            }
            invalid={Boolean(shown(errors?.material))}
            describedBy={describedBy}
            addLabel={(typed) => term('purchasing.editor.quickAddOption', profile, { name: typed })}
            onPick={pickMaterial}
            onAdd={onAddMaterial}
          />
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('purchasing.editor.removeLine')}
            onClick={onRemove}
            className="shrink-0 text-muted-foreground lg:row-start-1 lg:[grid-column:-2]"
          >
            <Trash2Icon aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 lg:contents">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <Caption>{t('purchasing.editor.qty')}</Caption>
          <Input
            aria-label={t('purchasing.editor.qty')}
            aria-invalid={Boolean(shown(errors?.qty))}
            aria-describedby={describedBy}
            placeholder={t('purchasing.editor.qtyPlaceholder')}
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
          <Caption>{t('purchasing.editor.unit')}</Caption>
          <NativeSelect
            aria-label={t('purchasing.editor.unit')}
            aria-invalid={Boolean(shown(errors?.unit))}
            aria-describedby={describedBy}
            value={validUnit ? line.unit : ''}
            onChange={(event) => onChange({ ...line, unit: event.target.value as LineUnit })}
            disabled={!material}
          >
            <option value="" disabled>
              {t('catalog.form.unitPlaceholder')}
            </option>
            {material && material.packs.length > 0 ? (
              <optgroup label={t('purchasing.editor.packs')}>
                {material.packs.map((pack) => {
                  const holds = quantityInWords(material, '1' as Quantity, { pack: pack.id })
                  const last = holds?.at(-1)
                  return (
                    <option key={pack.id} value={`pack:${pack.id}`}>
                      {last?.kind === 'unit'
                        ? `${pack.name} (${unitQuantity(last.qty, last.unit)})`
                        : pack.name}
                    </option>
                  )
                })}
              </optgroup>
            ) : null}
            {material
              ? dimensionsOf(material).map((dimension) => (
                  <optgroup key={dimension} label={t(`units.dimensions.${dimension}`)}>
                    {UNITS_BY_DIMENSION[dimension].map((unit) => (
                      <option key={unit} value={`unit:${unit}`}>
                        {t(`units.names.${unit}`)}
                      </option>
                    ))}
                  </optgroup>
                ))
              : null}
          </NativeSelect>
        </div>
      </div>
      {words ? (
        <p
          data-qty-words
          className="mt-1.5 ps-1 text-sm text-muted-foreground lg:row-start-2 lg:mt-0 lg:[grid-column:1/4]"
        >
          {words}
        </p>
      ) : null}
      <div
        className={cn(
          'mt-2 grid items-end gap-2 lg:contents',
          vatRegistered ? 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid-cols-1',
        )}
      >
        <div className="min-w-0 lg:col-start-4 lg:row-start-1">
          <Caption>{priceLabel}</Caption>
          <MoneyInput
            label={priceLabel}
            value={line.price}
            invalid={Boolean(shown(errors?.price))}
            describedBy={describedBy}
            onChange={(value) => onChange({ ...line, price: value })}
          />
        </div>
        {vatRegistered ? (
          <div className="min-w-0 lg:col-start-5 lg:row-start-1">
            <Caption>{t('purchasing.editor.vat')}</Caption>
            <VatSelect
              value={line.vatRate}
              onChange={(vatRate) => onChange({ ...line, vatRate })}
            />
          </div>
        ) : null}
      </div>
      {/* The caption says before or with VAT; without VAT, the price is what was paid. */}
      {!vatRegistered || perUnit ? (
        <p className="mt-1.5 ps-1 text-sm text-muted-foreground lg:row-start-2 lg:mt-0 lg:[grid-column:4/-1]">
          {vatRegistered ? null : t('purchasing.editor.priceHintNoVat')}
          {!vatRegistered && perUnit ? ' · ' : null}
          {perUnit ? <bdi data-per-unit>{perUnit}</bdi> : null}
        </p>
      ) : null}
      <DiscountRow
        kind={line.discountKind}
        value={line.discount}
        invalid={Boolean(shown(errors?.discount))}
        describedBy={describedBy}
        addLabel={t('purchasing.editor.addDiscount')}
        label={t('purchasing.editor.lineDiscount')}
        onChange={(next) => onChange({ ...line, discountKind: next.kind, discount: next.value })}
        className="mt-1 lg:row-start-3 lg:[grid-column:1/4]"
      />
      <LineMessages
        id={messagesId}
        messages={messages}
        className="lg:row-start-4 lg:[grid-column:1/-1]"
      />
      {amounts ? (
        <p className="mt-2 flex flex-wrap items-baseline justify-end gap-x-3 border-t pt-2 text-sm lg:row-start-3 lg:mt-0 lg:self-center lg:border-t-0 lg:pt-0 lg:[grid-column:4/-1]">
          {vatRegistered && compareDecimal(amounts.vat, '0') > 0 ? (
            <span className="text-muted-foreground">
              {t('purchasing.editor.lineVat', { amount: money(amounts.vat) })}
            </span>
          ) : null}
          <span data-line-total className="font-medium">
            {t('purchasing.editor.lineTotal', {
              amount: money(vatRegistered ? amounts.total : amounts.taxable),
            })}
          </span>
        </p>
      ) : null}
    </fieldset>
  )
}

/** Delivery charged on the same invoice: what it is for, the amount and its VAT. */
export function DeliveryLineRow({
  line,
  errors,
  shown,
  vatRegistered,
  pricesIncludeVat,
  profile,
  onChange,
  onRemove,
}: {
  line: DeliveryLineDraft
  errors: LineErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  vatRegistered: boolean
  pricesIncludeVat: boolean
  profile: TerminologyProfile
  onChange: (line: DeliveryLineDraft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const messagesId = useId()
  const messages = [shown(errors?.amount), shown(errors?.description)].filter((m): m is string =>
    Boolean(m),
  )
  const describedBy = messages.length > 0 ? messagesId : undefined
  const amountLabel = vatRegistered
    ? t(
        pricesIncludeVat
          ? 'purchasing.editor.deliveryAmountInclVat'
          : 'purchasing.editor.deliveryAmountBeforeVat',
      )
    : t('purchasing.editor.deliveryAmount')
  return (
    <fieldset
      data-delivery-row
      className={cn('rounded-xl border bg-background/60 p-3', lineGrid(vatRegistered))}
    >
      <legend className="sr-only">{t('purchasing.editor.delivery')}</legend>
      <div className="flex items-end gap-2 lg:contents">
        <div className="min-w-0 flex-1 lg:row-start-1 lg:[grid-column:1/4]">
          <Caption>{t('purchasing.editor.delivery')}</Caption>
          <Input
            aria-label={t('purchasing.editor.deliveryDescription')}
            aria-invalid={Boolean(shown(errors?.description))}
            aria-describedby={describedBy}
            placeholder={t('purchasing.editor.deliveryPlaceholder')}
            autoComplete="off"
            value={line.description}
            onChange={(event) => onChange({ ...line, description: event.target.value })}
            className="[unicode-bidi:plaintext]"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('purchasing.editor.removeDelivery')}
          onClick={onRemove}
          className="shrink-0 text-muted-foreground lg:row-start-1 lg:[grid-column:-2]"
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <div
        className={cn(
          'mt-2 grid items-end gap-2 lg:contents',
          vatRegistered ? 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid-cols-1',
        )}
      >
        <div className="min-w-0 lg:col-start-4 lg:row-start-1">
          <Caption>{amountLabel}</Caption>
          <MoneyInput
            label={amountLabel}
            value={line.amount}
            invalid={Boolean(shown(errors?.amount))}
            describedBy={describedBy}
            onChange={(amount) => onChange({ ...line, amount })}
          />
        </div>
        {vatRegistered ? (
          <div className="min-w-0 lg:col-start-5 lg:row-start-1">
            <Caption>{t('purchasing.editor.vat')}</Caption>
            <VatSelect
              value={line.vatRate}
              onChange={(vatRate) => onChange({ ...line, vatRate })}
            />
          </div>
        ) : null}
      </div>
      <p className="mt-1.5 ps-1 text-sm text-muted-foreground lg:row-start-2 lg:mt-0 lg:[grid-column:1/-1]">
        {term('purchasing.editor.deliveryHint', profile)}
      </p>
      <LineMessages
        id={messagesId}
        messages={messages}
        className="lg:row-start-3 lg:[grid-column:1/-1]"
      />
    </fieldset>
  )
}

/** "+ Add a material" and "+ Add a delivery charge". */
export function AddLineButtons({
  onMaterial,
  onDelivery,
  materialLabel,
}: {
  onMaterial: () => void
  onDelivery: () => void
  materialLabel: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={onMaterial}>
        <PlusIcon aria-hidden />
        {materialLabel}
      </Button>
      <Button type="button" variant="ghost" onClick={onDelivery}>
        <TruckIcon aria-hidden />
        {t('purchasing.editor.addDelivery')}
      </Button>
    </div>
  )
}

/**
 * Whether the purchase's prices are typed before VAT or with it (a VAT-registered business; the
 * owner's request of 2026-09-29). The prices' captions follow it.
 */
export function VatModeChoice({
  value,
  onChange,
}: {
  value: boolean
  onChange: (includesVat: boolean) => void
}) {
  const { t } = useTranslation()
  const name = useId()
  return (
    <fieldset data-vat-mode className="mb-4">
      <legend className="sr-only">{t('purchasing.editor.vatMode.label')}</legend>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {[false, true].map((includesVat) => (
          <label key={String(includesVat)} className="relative min-w-0">
            <input
              type="radio"
              name={name}
              value={includesVat ? 'included' : 'before'}
              checked={value === includesVat}
              onChange={() => onChange(includesVat)}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
              )}
            >
              {t(
                includesVat
                  ? 'purchasing.editor.vatMode.included'
                  : 'purchasing.editor.vatMode.before',
              )}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {t(
          value ? 'purchasing.editor.vatMode.includedHint' : 'purchasing.editor.vatMode.beforeHint',
        )}
      </p>
    </fieldset>
  )
}
