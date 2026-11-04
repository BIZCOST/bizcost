'use client'

import type { StandardUnit } from '@bizcost/domain'
import { Fragment } from 'react'
import { useFormatQuantity, useUnitQuantity } from '@/features/catalog/unit-parts'
import { nameAfterQuantity, NBSP, type ChainStep } from '@/features/catalog/units'
import { cn } from '@/lib/utils'
import { magnitude, stockInWords, type StockUnits } from './stock-words'

// Stock quantities on screen (M4 Step 2): "12 cartons + 3 bottles (147 L)", each part in its own
// direction (an English pack name reads well in the Arabic page and an Arabic one in the English
// page), never broken between a number and what it counts.

/** "−" for a quantity below zero (U+2212, as the screens write a negative amount). */
const MINUS = '−'

/** One step said in words: "12 cartons", "3 L". */
export function useStepWords() {
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  return (step: ChainStep) =>
    step.kind === 'pack'
      ? `${format(step.qty)}${NBSP}${nameAfterQuantity(step.name, step.qty)}`
      : unitQuantity(step.qty, step.unit).replaceAll(' ', NBSP)
}

/** A quantity of the counting unit, with its sign when asked: "+24 L", "−80 L", "147 L". */
export function useSignedUnitQuantity() {
  const unitQuantity = useUnitQuantity()
  return (qty: string, unit: StandardUnit, signed = false) => {
    const negative = qty.startsWith('-')
    const sign = negative ? MINUS : signed && qty !== '0' ? '+' : ''
    return `${sign}${unitQuantity(magnitude(qty), unit).replaceAll(' ', NBSP)}`
  }
}

/** A movement's base quantity in the counting unit, with its sign: "+24 L", "−12 L". */
export function useSignedStock() {
  const unitQuantity = useSignedUnitQuantity()
  return (material: StockUnits, baseQty: string) => {
    const words = stockInWords(material, baseQty)
    return unitQuantity(words.negative ? `-${words.total}` : words.total, words.unit, true)
  }
}

/** Stock in words as one string (for a sentence: isolate it). */
export function useStockText() {
  const step = useStepWords()
  const unitQuantity = useSignedUnitQuantity()
  return (material: StockUnits, baseQty: string) => {
    const words = stockInWords(material, baseQty)
    const total = unitQuantity(words.negative ? `-${words.total}` : words.total, words.unit)
    if (words.parts.length === 0) return total
    const only = words.parts.length === 1 && words.parts[0]!.kind === 'unit'
    if (only) return total
    return `${words.parts.map(step).join(' + ')} (${total})`
  }
}

/** Stock in words: "12 cartons + 3 bottles (147 L)"; below zero, in the counting unit ("−3 L"). */
export function StockQty({
  material,
  qty,
  className,
}: {
  material: StockUnits
  /** Base units, signed. */
  qty: string
  className?: string
}) {
  const step = useStepWords()
  const unitQuantity = useSignedUnitQuantity()
  const words = stockInWords(material, qty)
  const total = unitQuantity(words.negative ? `-${words.total}` : words.total, words.unit)
  const packs = words.parts.length > 0 && words.parts.some((part) => part.kind === 'pack')
  return (
    <span
      data-stock-qty
      className={cn('tabular-nums', words.negative && 'text-destructive', className)}
    >
      {packs ? (
        <>
          {words.parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 ? ' + ' : null}
              <bdi>{step(part)}</bdi>
            </Fragment>
          ))}{' '}
          <bdi className="text-muted-foreground">({total})</bdi>
        </>
      ) : (
        <bdi>{total}</bdi>
      )}
    </span>
  )
}
