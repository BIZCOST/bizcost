import type { MaterialCrossFactorDto, MaterialPackDto } from '@bizcost/contracts'
import {
  dimensionOf,
  DIMENSIONS,
  fromBase,
  STANDARD_UNITS,
  unitFactor,
  type Dimension,
  type MaterialUnits,
  type Quantity,
  type StandardUnit,
  type UnitRef,
} from '@bizcost/domain'

// Units on the screens of Materials and Products & Services (M2 Step 2; D-108, D-122): the unit
// lists by kind of measure, and a material's packs said in words ("1 carton = 12 bottles = 12 L").
// The conversions are the domain units engine's own (exact fractions), so what the screen says is
// what purchases will use.

/** The units of each kind of measure, largest first (the order of the pickers). */
export const UNITS_BY_DIMENSION: Readonly<Record<Dimension, readonly StandardUnit[]>> = {
  mass: ['kg', 'g', 'mg'],
  volume: ['l', 'ml'],
  count: ['piece'],
  length: ['m', 'cm', 'mm'],
  area: ['m2', 'cm2', 'mm2'],
  time: ['h', 'min', 's'],
}

/** Every standard unit, grouped by kind of measure. */
export const UNIT_GROUPS: readonly { dimension: Dimension; units: readonly StandardUnit[] }[] =
  DIMENSIONS.map((dimension) => ({ dimension, units: UNITS_BY_DIMENSION[dimension] }))

export function isUnit(value: string): value is StandardUnit {
  return Object.hasOwn(STANDARD_UNITS, value)
}

/** A material's packs and cross factors as the units engine reads them. */
export function materialUnits(
  unit: StandardUnit,
  packs: readonly Pick<MaterialPackDto, 'id' | 'qty' | 'ofUnit' | 'ofPackId'>[],
  crossFactors: readonly Pick<MaterialCrossFactorDto, 'unit' | 'qty' | 'ofUnit'>[],
): MaterialUnits {
  return {
    dimension: dimensionOf(unit),
    packs: packs.map((pack) => ({
      id: pack.id,
      qty: pack.qty,
      of: pack.ofPackId ? { pack: pack.ofPackId } : (pack.ofUnit ?? ('' as StandardUnit)),
    })),
    crossFactors: crossFactors.map((cross) => ({
      unit: cross.unit,
      qty: cross.qty,
      of: cross.ofUnit,
    })),
  }
}

/** One step of a pack's chain: a quantity of a named pack or of a standard unit. */
export type ChainStep =
  | { readonly kind: 'pack'; readonly qty: string; readonly name: string }
  | { readonly kind: 'unit'; readonly qty: string; readonly unit: StandardUnit }

/**
 * A pack said in words, from one of it down to a standard unit, then in the material's own unit
 * when that one differs: 1 carton = 12 bottle = 12 l (a material counted in l), or 1 bag = 5 kg =
 * 5000 g (counted in g). Quantities are exact to 6 decimals. Null when the chain cannot be followed
 * (validate the units first: an unknown pack, a loop, or a unit without a conversion).
 */
export function packChain(
  packId: string,
  packs: readonly Pick<MaterialPackDto, 'id' | 'name' | 'qty' | 'ofUnit' | 'ofPackId'>[],
  units: MaterialUnits,
  countingUnit: StandardUnit,
): ChainStep[] | null {
  const byId = new Map(packs.map((pack) => [pack.id, pack]))
  const start = byId.get(packId)
  if (!start) return null
  try {
    // Base units in one pack (exact; fromBase divides it once and rounds to 6 decimals).
    const base = unitFactor({ pack: start.id }, units) as Quantity
    const qtyIn = (unit: UnitRef) => fromBase(base, unit, units)
    const steps: ChainStep[] = [{ kind: 'pack', qty: '1', name: start.name }]
    const seen = new Set([start.id])
    let pack = start
    while (pack.ofPackId) {
      const next = byId.get(pack.ofPackId)
      if (!next || seen.has(next.id)) return null
      seen.add(next.id)
      steps.push({ kind: 'pack', qty: qtyIn({ pack: next.id }), name: next.name })
      pack = next
    }
    if (!pack.ofUnit) return null
    steps.push({ kind: 'unit', qty: qtyIn(pack.ofUnit), unit: pack.ofUnit })
    if (pack.ofUnit !== countingUnit) {
      steps.push({ kind: 'unit', qty: qtyIn(countingUnit), unit: countingUnit })
    }
    return steps
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/**
 * The packs no other pack holds: the biggest ones, whose chains name every pack (a carton of
 * bottles says the bottle too). In the order they were added.
 */
export function outerPacks<T extends Pick<MaterialPackDto, 'id' | 'ofPackId'>>(
  packs: readonly T[],
): T[] {
  const inner = new Set(packs.map((pack) => pack.ofPackId).filter(Boolean))
  return packs.filter((pack) => !inner.has(pack.id))
}

/** A no-break space: keeps a number with what it counts on one line. */
export const NBSP = '\u00a0'

/** One English word (letters, maybe hyphens): a name the English plural rules can be applied to. */
const ENGLISH_WORD = /^[A-Za-z][A-Za-z-]*$/

/** Whole counts 3 to 10: an Arabic count word after them is plural, which a typed name is not. */
const THREE_TO_TEN = /^(?:[3-9]|10)$/

/**
 * A pack's name after a quantity (D-132). A one-word English name gets its plural when the quantity
 * is not 1 ("12 bottles", "3 boxes", "4 batteries"), unless it already ends in s or is in capitals
 * ("glass", "BOX"). A name without Latin letters (an Arabic one) after 3 to 10 reads as a count, "×
 * كيس" ("6 × كيس"), since «6 كيس» is not Arabic and the app cannot know the typed word's plural; from 11
 * on, and after 1 or 2, the singular reads correctly. Anything else stays as typed ("tray of eggs").
 * The × is joined to the name by a no-break space.
 */
export function nameAfterQuantity(name: string, qty: string): string {
  const trimmed = name.trim()
  if (qty === '1') return trimmed
  if (ENGLISH_WORD.test(trimmed)) {
    if (/s$/i.test(trimmed) || trimmed === trimmed.toUpperCase()) return trimmed
    if (/(x|z|ch|sh)$/i.test(trimmed)) return `${trimmed}es`
    if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`
    return `${trimmed}s`
  }
  if (THREE_TO_TEN.test(qty) && !/[A-Za-z]/.test(trimmed)) return `×${NBSP}${trimmed}`
  return trimmed
}

/** Decimal places of a canonical decimal string ("0.25" → 2). */
export function decimalPlaces(value: string): number {
  const point = value.indexOf('.')
  return point < 0 ? 0 : value.length - point - 1
}
