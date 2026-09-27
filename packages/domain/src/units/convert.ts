import type Decimal from 'decimal.js'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import {
  COST_SCALE,
  QUANTITY_SCALE,
  type CostAmount,
  type Money,
  type Quantity,
  type UnitCost,
} from '../numbers/kinds'
import type { MaterialUnits, PackDefinition, UnitRef } from './materials'
import { dimensionOf, isStandardUnit, STANDARD_UNITS, type StandardUnit } from './standard'

// The unit chain of the owner's spec §12: purchase unit → packs → base unit → cost per base unit →
// recipe quantity → product cost.
//
// How many base units one unit is: an exact fraction num ÷ den. num multiplies the pack quantities,
// the standard factors and a cross factor; den is 1, except through a cross factor, where it is the
// standard factor of the cross factor's unit (60 for 'min', 3600 for 'h': 1/60 has no exact decimal).
// Each result multiplies its numerator exactly and divides ONCE, then rounds half away from zero once:
// quantities to 6 decimals (numeric(24,6)), costs to 12 (numeric(28,12)); never to the currency.
//
// Validate a material's units with validateMaterialUnits when they are saved. These functions throw
// RangeError on a unit they cannot resolve (an unknown or looping pack, a dimension with no
// conversion).

/** Base units per one unit, as an exact fraction. */
interface Ratio {
  readonly num: Decimal
  readonly den: Decimal
}

/**
 * How many base units one `unit` is for this material: carton → '12000' (ml). Exact, except through
 * a cross factor on 'min' or 'h', where it is rounded to 12 decimals (the scale of numeric(28,12)).
 * Conversions never use this rounded value: they use the exact fraction.
 */
export function unitFactor(unit: UnitRef, units: MaterialUnits): string {
  const { num, den } = ratio(unit, units)
  return plain(roundHalfUp(num.dividedBy(den), COST_SCALE))
}

/** A quantity in `unit` as base units, to 6 decimals: 1.5 carton → 18000 (ml). */
export function toBase(qty: Quantity, unit: UnitRef, units: MaterialUnits): Quantity {
  const { num, den } = ratio(unit, units)
  return plain(
    roundHalfUp(exactProduct([toDec(qty), num]).dividedBy(den), QUANTITY_SCALE),
  ) as Quantity
}

/** A base-unit quantity expressed in `unit`, to 6 decimals: 18000 ml → 1.5 carton. */
export function fromBase(baseQty: Quantity, unit: UnitRef, units: MaterialUnits): Quantity {
  const { num, den } = ratio(unit, units)
  return plain(
    roundHalfUp(exactProduct([toDec(baseQty), den]).dividedBy(num), QUANTITY_SCALE),
  ) as Quantity
}

/**
 * Cost of one base unit when `qty` `unit` cost `price` in total, unrounded to the currency (12
 * decimals): AED 72 for 1 carton of 12 × 1 L bottles → 0.006 per ml. `qty` must be more than zero.
 */
export function costPerBaseUnit(
  price: Money | CostAmount,
  qty: Quantity,
  unit: UnitRef,
  units: MaterialUnits,
): UnitCost {
  const { num, den } = ratio(unit, units)
  const baseQty = exactProduct([toDec(qty), num])
  if (!baseQty.gt(0)) throw new RangeError('The purchased quantity must be more than zero')
  const cost = toDec(price)
  if (cost.lt(0)) throw new RangeError('The price must not be negative')
  return plain(roundHalfUp(exactProduct([cost, den]).dividedBy(baseQty), COST_SCALE)) as UnitCost
}

/** Cost of `qty` `unit` of a material at `costPerBase` (12 decimals): 200 ml × 0.006 → 1.2. */
export function recipeLineCost(
  qty: Quantity,
  unit: UnitRef,
  costPerBase: UnitCost,
  units: MaterialUnits,
): CostAmount {
  const { num, den } = ratio(unit, units)
  return plain(
    roundHalfUp(exactProduct([toDec(qty), num, toDec(costPerBase)]).dividedBy(den), COST_SCALE),
  ) as CostAmount
}

function ratio(unit: UnitRef, units: MaterialUnits): Ratio {
  if (typeof unit === 'string') return standardRatio(unit, units)
  const packs = new Map<string, PackDefinition>()
  for (const pack of units.packs ?? []) {
    if (packs.has(pack.id)) throw new RangeError(`Duplicate pack "${pack.id}"`)
    packs.set(pack.id, pack)
  }
  const seen = new Set<string>()
  const quantities: Decimal[] = []
  for (let ref: UnitRef = unit; ;) {
    if (typeof ref === 'string') {
      const end = standardRatio(ref, units)
      return { num: exactProduct([...quantities, end.num]), den: end.den }
    }
    const pack = packs.get(ref.pack)
    if (!pack) throw new RangeError(`Unknown pack "${ref.pack}"`)
    if (seen.has(pack.id)) throw new RangeError(`Pack "${pack.id}" is part of a loop`)
    seen.add(pack.id)
    quantities.push(positive(pack.qty))
    ref = pack.of
  }
}

function standardRatio(unit: StandardUnit, units: MaterialUnits): Ratio {
  if (!isStandardUnit(unit)) throw new RangeError(`Unknown unit "${unit}"`)
  const own = toDec(STANDARD_UNITS[unit].factor)
  const dimension = dimensionOf(unit)
  if (dimension === units.dimension) return { num: own, den: toDec('1') }
  const cross = units.crossFactors?.find(
    (c) => isStandardUnit(c.unit) && dimensionOf(c.unit) === dimension,
  )
  if (!cross || !isStandardUnit(cross.of) || dimensionOf(cross.of) !== units.dimension) {
    throw new RangeError(`No conversion from ${dimension} to ${units.dimension}`)
  }
  // unit → the other dimension's base → cross.unit → cross.of → the material's base.
  return {
    num: exactProduct([own, positive(cross.qty), toDec(STANDARD_UNITS[cross.of].factor)]),
    den: toDec(STANDARD_UNITS[cross.unit].factor),
  }
}

function positive(qty: string): Decimal {
  const value = toDec(qty)
  if (!value.gt(0)) throw new RangeError(`A conversion must be more than zero: "${qty}"`)
  return value
}
