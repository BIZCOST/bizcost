import {
  BASE_UNITS,
  compareDecimal,
  fromBase,
  subtractDecimals,
  sumDecimals,
  toBase,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import { outerPacks, type ChainStep } from '../catalog/units'
import { unitsOf, type MaterialUnitsDto } from '../purchasing/line-units'

// Stock said in words (M4 Step 2): "12 cartons + 3 bottles (147 L)". A base quantity (ml, g, piece…)
// is split down the material's biggest pack's chain into whole packs (the first pack no other pack
// holds, then the pack it holds…), with what is left in the unit it is counted in, and the whole
// quantity in that unit beside it. The conversions are the domain units engine's own (the API counts
// with them), each a decimal string: nothing here is a float.

/** What stock screens know of a material's units (a stock answer's `material`). */
export type StockUnits = MaterialUnitsDto

export interface StockWords {
  /** Below zero (more went out than was recorded in): said in the counting unit only. */
  readonly negative: boolean
  /**
   * Whole packs down the biggest pack's chain, then what is left in the counting unit; empty when no
   * whole pack fits (the total says it all).
   */
  readonly parts: readonly ChainStep[]
  /** The whole quantity, without its sign, in `unit`. */
  readonly total: string
  /**
   * The unit `total` is in: the counting unit, or the base unit (ml, g…) when it can't be said in
   * it (a quantity too large to convert).
   */
  readonly unit: StandardUnit
}

/** The biggest pack and the packs inside it, outermost first (empty without packs). */
function packChainOf(material: StockUnits): StockUnits['packs'] {
  const outer = outerPacks(material.packs)[0]
  if (!outer) return []
  const byId = new Map(material.packs.map((pack) => [pack.id, pack]))
  const chain = [outer]
  const seen = new Set([outer.id])
  let pack = outer
  while (pack.ofPackId) {
    const next = byId.get(pack.ofPackId)
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    chain.push(next)
    pack = next
  }
  return chain
}

/** The whole part of a non-negative decimal string ("12.75" → "12"). */
function wholePart(value: string): string {
  return value.split('.')[0] ?? '0'
}

/** `baseQty` (base units, signed) said in whole packs and the counting unit. */
export function stockInWords(material: StockUnits, baseQty: string): StockWords {
  const negative = baseQty.startsWith('-')
  const abs = (negative ? baseQty.slice(1) : baseQty) as Quantity
  const units = unitsOf(material)
  const unit = material.unit
  let total: string
  try {
    total = fromBase(abs, unit, units)
  } catch (error) {
    if (error instanceof RangeError) {
      return { negative, parts: [], total: abs, unit: BASE_UNITS[material.dimension] }
    }
    throw error
  }
  if (negative || compareDecimal(abs, '0') === 0) return { negative, parts: [], total, unit }
  const parts: ChainStep[] = []
  let left: string = abs
  try {
    for (const pack of packChainOf(material)) {
      const unit = { pack: pack.id }
      let whole = wholePart(fromBase(left as Quantity, unit, units))
      if (whole === '0') continue
      let used = toBase(whole as Quantity, unit, units)
      // fromBase rounds to 6 decimals: 11.9999996 packs read as 12, of which only 11 are there.
      if (compareDecimal(used, left) > 0) {
        whole = subtractDecimals(whole, '1')
        used = toBase(whole as Quantity, unit, units)
      }
      if (compareDecimal(whole, '0') <= 0) continue
      parts.push({ kind: 'pack', qty: whole, name: pack.name })
      left = subtractDecimals(left, used)
    }
  } catch (error) {
    if (error instanceof RangeError) return { negative, parts: [], total, unit }
    throw error
  }
  if (parts.length === 0) return { negative, parts: [], total, unit }
  const rest = fromBase(left as Quantity, unit, units)
  if (compareDecimal(rest, '0') > 0) parts.push({ kind: 'unit', qty: rest, unit })
  return { negative, parts, total, unit }
}

/** Which way a difference (counted − expected) goes. */
export type DifferenceSide = 'more' | 'less' | 'same'

export function differenceSide(difference: string): DifferenceSide {
  const sign = compareDecimal(difference, '0')
  return sign > 0 ? 'more' : sign < 0 ? 'less' : 'same'
}

/** What finalizing a count changes, as its confirmation says it. */
export interface DifferencesSummary {
  /** Lines whose counted quantity differs from what was expected (a quantity, whatever its value). */
  readonly differing: number
  /**
   * What the differences move the stock's value by, added up (signed); undefined when a value is
   * hidden (no costs switch), null when no counted line has one.
   */
  readonly total: string | null | undefined
}

/**
 * The counted lines' differences (counted − expected) and their values: "everything matches" only
 * when no line's quantity differs, so a −72 and a +72, or an unpriced material counted short (AED 0),
 * are differences even when the value nets to zero.
 */
export function summarizeDifferences(
  lines: readonly {
    readonly differenceQty: string | null
    readonly differenceValue?: string | null
  }[],
): DifferencesSummary {
  const differing = lines.filter(
    (line) => line.differenceQty !== null && compareDecimal(line.differenceQty, '0') !== 0,
  ).length
  if (lines.some((line) => line.differenceValue === undefined))
    return { differing, total: undefined }
  const known = lines
    .map((line) => line.differenceValue)
    .filter((value): value is string => value !== null && value !== undefined)
  return { differing, total: known.length === 0 ? null : sumDecimals(known) }
}

/** A signed decimal string without its sign ("-80" → "80"). */
export function magnitude(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value
}
