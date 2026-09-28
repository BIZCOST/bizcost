'use client'

import type { Dimension, StandardUnit } from '@bizcost/domain'
import { formatDecimal } from '@bizcost/i18n'
import { Fragment, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NativeSelect } from '@/components/ui/native-select'
import { useLocale } from '@/lib/i18n/client'
import {
  decimalPlaces,
  isUnit,
  nameAfterQuantity,
  NBSP,
  UNITS_BY_DIMENSION,
  type ChainStep,
} from './units'

// How units read on the catalog screens: quantities in the page's language with Latin digits
// (D-067), unit names by kind of measure, and a pack's chain in words.

/** Most decimals a quantity shows (the engine keeps 6 for quantities, D-107). */
const QUANTITY_DECIMALS = 6

/** A quantity as a decimal string, shown with its own decimals (up to 6): 12, 0.92, 1,000. */
export function useFormatQuantity() {
  const { locale } = useLocale()
  return (value: string) =>
    formatDecimal(locale, value, Math.min(decimalPlaces(value), QUANTITY_DECIMALS))
}

/** "12 L", "3 pieces": a quantity of a standard unit, in the page's language. */
export function useUnitQuantity() {
  const { t } = useTranslation()
  const format = useFormatQuantity()
  // The count only picks the plural form; the number shown is the exact decimal string.
  return (qty: string, unit: StandardUnit) =>
    t(`units.qty.${unit}`, { count: Number(qty), value: format(qty) })
}

/**
 * A pack said in words: "1 carton = 12 bottles = 12 L". Each step keeps its own direction, so an
 * English pack name reads well in the Arabic page and an Arabic one in the English page. A line
 * breaks only after an "=", never between a number and what it counts.
 */
export function PackChainText({ steps }: { steps: readonly ChainStep[] }) {
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  return (
    <span data-chain>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 ? `${NBSP}= ` : null}
          <bdi>
            {step.kind === 'pack'
              ? `${format(step.qty)}${NBSP}${nameAfterQuantity(step.name, step.qty)}`
              : unitQuantity(step.qty, step.unit).replaceAll(' ', NBSP)}
          </bdi>
        </Fragment>
      ))}
    </span>
  )
}

/**
 * A choice of standard units, grouped by kind of measure (only `dimensions`, in their order).
 * `extra` adds options after the units (e.g. the material's packs). A unit chosen before that is no
 * longer offered (another kind of measure, after the material's unit changed) still shows, marked
 * and disabled, so the box says what the form holds; picking another unit replaces it.
 */
export function UnitSelect({
  value,
  onValueChange,
  dimensions,
  placeholder,
  valuePrefix = '',
  exclude,
  extra,
  ...props
}: Omit<ComponentProps<typeof NativeSelect>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  dimensions: readonly Dimension[]
  /** Shown while nothing is chosen. */
  placeholder?: string
  /** Put before each unit's value (`unit:` when packs are options too). */
  valuePrefix?: string
  exclude?: readonly StandardUnit[]
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  const chosen = value.startsWith(valuePrefix) ? value.slice(valuePrefix.length) : ''
  const offered = dimensions.some((dimension) =>
    UNITS_BY_DIMENSION[dimension].some((unit) => unit === chosen && !exclude?.includes(unit)),
  )
  const stale = isUnit(chosen) && !offered ? chosen : null
  return (
    <NativeSelect value={value} onChange={(event) => onValueChange(event.target.value)} {...props}>
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {stale ? (
        <option value={value} disabled>
          {t('catalog.form.otherKindOption', { unit: t(`units.names.${stale}`) })}
        </option>
      ) : null}
      {dimensions.map((dimension) => (
        <optgroup key={dimension} label={t(`units.dimensions.${dimension}`)}>
          {UNITS_BY_DIMENSION[dimension]
            .filter((unit) => !exclude?.includes(unit))
            .map((unit) => (
              <option key={unit} value={`${valuePrefix}${unit}`}>
                {t(`units.names.${unit}`)}
              </option>
            ))}
        </optgroup>
      ))}
      {extra}
    </NativeSelect>
  )
}
