import type { MaterialDto } from '@bizcost/contracts'
import {
  BASE_UNITS,
  checkDecimal,
  compareDecimal,
  costPerBaseUnit,
  dimensionOf,
  fromBase,
  recipeLineCost,
  toBase,
  type Dimension,
  type Money,
  type MaterialUnits,
  type Quantity,
  type StandardUnit,
  type UnitRef,
} from '@bizcost/domain'
import { materialUnits, outerPacks, UNITS_BY_DIMENSION, type ChainStep } from '../catalog/units'

// The units a purchase line can be in (M2 Step 3; D-108, D-110 rule 4): one of the material's packs,
// a standard unit of its kind of measure, or a unit of another kind through its conversion. The
// conversions are the domain units engine's own, the ones the API posts with, so what a line says in
// words ("2 cartons = 24 bottles = 24 L") is what comes into stock.

/** A line's unit as the form holds it: `unit:kg`, `pack:<id>`, or '' until chosen. */
export type LineUnit = '' | `unit:${StandardUnit}` | `pack:${string}`

export function unitRefOf(value: LineUnit): UnitRef | null {
  if (value.startsWith('unit:')) return value.slice(5) as StandardUnit
  if (value.startsWith('pack:')) return { pack: value.slice(5) }
  return null
}

export function lineUnitOf(unit: StandardUnit | null, packId: string | null): LineUnit {
  if (packId) return `pack:${packId}`
  return unit ? `unit:${unit}` : ''
}

/** The units engine's view of a material. */
export function unitsOf(material: MaterialDto): MaterialUnits {
  return materialUnits(material.unit, material.packs, material.crossFactors)
}

/** The kinds of measure a material can be bought in: its own, then those it has a conversion for. */
export function dimensionsOf(material: MaterialDto): Dimension[] {
  const own = material.dimension
  return [own, ...material.crossFactors.map((cross) => dimensionOf(cross.unit))].filter(
    (dimension, index, all) => all.indexOf(dimension) === index,
  )
}

/** Whether `value` is a unit this material can be bought in (its pack, or a unit it converts). */
export function isUnitOf(material: MaterialDto, value: LineUnit): boolean {
  if (value.startsWith('pack:')) return material.packs.some((pack) => `pack:${pack.id}` === value)
  if (!value.startsWith('unit:')) return false
  const unit = value.slice(5) as StandardUnit
  return dimensionsOf(material).some((dimension) => UNITS_BY_DIMENSION[dimension].includes(unit))
}

/**
 * The unit a new line of this material starts in: the biggest pack it is bought in (the first pack
 * no other pack holds), else the unit it is counted in. People buy the way the material was set up.
 */
export function defaultUnitOf(material: MaterialDto): LineUnit {
  const pack = outerPacks(material.packs)[0]
  return pack ? `pack:${pack.id}` : `unit:${material.unit}`
}

/**
 * A quantity of `unit` in base units: null when it does not convert, is not more than zero once
 * rounded, or is more than a stored quantity holds (the API refuses the same, D-130).
 */
export function baseQuantity(
  material: MaterialDto,
  qty: Quantity,
  unit: UnitRef,
): { ok: true; base: Quantity } | { ok: false; error: 'too_small' | 'too_large' | 'unit' } {
  let base: Quantity
  try {
    base = toBase(qty, unit, unitsOf(material))
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: 'unit' }
    throw error
  }
  if (compareDecimal(base, '0') <= 0) return { ok: false, error: 'too_small' }
  if (checkDecimal(base, 'quantity') !== null) return { ok: false, error: 'too_large' }
  return { ok: true, base }
}

/**
 * A quantity said in words, down the pack's chain to the unit the material is counted in: 2 carton →
 * [2 carton, 24 bottle, 24 l]; 500 g of a material counted in kg → [500 g, 0.5 kg]. A quantity
 * already in the counting unit says nothing more ([]). Null when it cannot be converted.
 */
export function quantityInWords(
  material: MaterialDto,
  qty: Quantity,
  unit: UnitRef,
): ChainStep[] | null {
  const units = unitsOf(material)
  const counted = material.unit
  if (typeof unit === 'string' && unit === counted) return []
  try {
    const base = toBase(qty, unit, units)
    const steps: ChainStep[] = []
    if (typeof unit === 'string') {
      steps.push({ kind: 'unit', qty, unit })
    } else {
      const byId = new Map(material.packs.map((pack) => [pack.id, pack]))
      let pack = byId.get(unit.pack)
      if (!pack) return null
      steps.push({ kind: 'pack', qty, name: pack.name })
      const seen = new Set([pack.id])
      while (pack.ofPackId) {
        const next = byId.get(pack.ofPackId)
        if (!next || seen.has(next.id)) return null
        seen.add(next.id)
        steps.push({ kind: 'pack', qty: fromBase(base, { pack: next.id }, units), name: next.name })
        pack = next
      }
      if (!pack.ofUnit) return null
      if (pack.ofUnit !== counted) {
        steps.push({ kind: 'unit', qty: fromBase(base, pack.ofUnit, units), unit: pack.ofUnit })
      }
    }
    steps.push({ kind: 'unit', qty: fromBase(base, counted, units), unit: counted })
    return steps
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/**
 * What one of the material's counting unit costs when `qty` `unit` cost `amount` (12 decimals, for
 * display): AED 45 for 1 bag of 1 kg → 45 per kg. Null when it cannot be worked out.
 */
export function pricePerCountingUnit(
  material: MaterialDto,
  amount: string,
  qty: Quantity,
  unit: UnitRef,
): string | null {
  const units = unitsOf(material)
  try {
    const perBase = costPerBaseUnit(amount as Money, qty, unit, units)
    return recipeLineCost('1' as Quantity, material.unit, perBase, units)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/** The base unit of a material's kind of measure (ml for litres, g for kilos). */
export function baseUnitOf(material: MaterialDto): StandardUnit {
  return BASE_UNITS[material.dimension]
}
