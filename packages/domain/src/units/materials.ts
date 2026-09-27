import { toDec } from '../numbers/decimal'
import { checkDecimal } from '../numbers/kinds'
import { dimensionOf, isStandardUnit, type Dimension, type StandardUnit } from './standard'

// A material's own units (D-034; DATA_MODEL.md §6 materials + material_pack_conversions). People buy
// a material the way it is sold ("1 carton = 12 bottles, 1 bottle = 1 L"), so each material keeps:
// - its dimension: costs and stock are per base unit of it (units/standard.ts);
// - packs: named units, each "1 <pack> = qty <unit>", where <unit> is another pack or a standard
//   unit. Every chain must end at a standard unit, with no loops;
// - cross factors (optional): the only way to use standard units of another dimension, e.g. "1 l =
//   920 g" for oil kept in grams, or "1 piece = 150 g" for burger patties. At most one per dimension.
// Pack quantities and cross factors are exact decimals stored as numeric(28,12).

/** A standard unit code ('kg') or one of the material's packs ({ pack: id }). */
export type UnitRef = StandardUnit | { readonly pack: string }

export interface PackDefinition {
  /** Stable key of the pack (its conversion row id). */
  readonly id: string
  /** How many `of` one pack holds: 1 <pack> = qty <of>. More than zero. */
  readonly qty: string
  readonly of: UnitRef
}

export interface CrossFactor {
  /** A standard unit of another dimension ('l' for a material kept in grams). */
  readonly unit: StandardUnit
  /** 1 <unit> = qty <of>. More than zero. */
  readonly qty: string
  /** A standard unit of the material's own dimension. */
  readonly of: StandardUnit
}

export interface MaterialUnits {
  readonly dimension: Dimension
  readonly packs?: readonly PackDefinition[]
  readonly crossFactors?: readonly CrossFactor[]
}

export type MaterialUnitsErrorCode =
  | 'invalid_qty'
  | 'duplicate_pack'
  | 'unknown_pack'
  | 'unknown_unit'
  | 'cycle'
  | 'wrong_dimension'
  | 'cross_same_dimension'
  | 'cross_duplicate_dimension'
  | 'cross_wrong_target'

/** One problem, naming the pack or the cross factor's unit it concerns. */
export interface MaterialUnitsError {
  readonly code: MaterialUnitsErrorCode
  readonly pack?: string
  readonly unit?: string
}

/** A positive decimal that fits numeric(28,12), the column of conversion factors. */
export function isValidFactor(qty: string): boolean {
  return checkDecimal(qty, 'unitCost') === null && toDec(qty).gt(0)
}

/**
 * Every problem in a material's units (an empty list when they are valid): quantities that are not
 * positive decimals, duplicate or unknown packs, loops, chains ending in a dimension the material
 * cannot convert from, and cross factors on the material's own dimension, twice for one dimension
 * or not landing in the material's dimension.
 */
export function validateMaterialUnits(units: MaterialUnits): MaterialUnitsError[] {
  const errors: MaterialUnitsError[] = []
  const crossDimensions = new Set<Dimension>()
  for (const cross of units.crossFactors ?? []) {
    if (!isValidFactor(cross.qty)) errors.push({ code: 'invalid_qty', unit: cross.unit })
    if (!isStandardUnit(cross.of) || dimensionOf(cross.of) !== units.dimension) {
      errors.push({ code: 'cross_wrong_target', unit: cross.unit })
    }
    if (!isStandardUnit(cross.unit)) {
      errors.push({ code: 'unknown_unit', unit: cross.unit })
      continue
    }
    const dimension = dimensionOf(cross.unit)
    if (dimension === units.dimension)
      errors.push({ code: 'cross_same_dimension', unit: cross.unit })
    else if (crossDimensions.has(dimension)) {
      errors.push({ code: 'cross_duplicate_dimension', unit: cross.unit })
    } else crossDimensions.add(dimension)
  }

  const packs = new Map<string, PackDefinition>()
  for (const pack of units.packs ?? []) {
    if (packs.has(pack.id)) errors.push({ code: 'duplicate_pack', pack: pack.id })
    else packs.set(pack.id, pack)
    if (!isValidFactor(pack.qty)) errors.push({ code: 'invalid_qty', pack: pack.id })
  }
  for (const pack of packs.values()) {
    const end = chainEnd(pack, packs)
    if (!isStandardUnit(end)) errors.push({ code: end, pack: pack.id })
    else if (dimensionOf(end) !== units.dimension && !crossDimensions.has(dimensionOf(end))) {
      errors.push({ code: 'wrong_dimension', pack: pack.id })
    }
  }
  return errors
}

/** The standard unit a pack's chain ends at, or why it does not end. */
function chainEnd(
  start: PackDefinition,
  packs: ReadonlyMap<string, PackDefinition>,
): StandardUnit | 'cycle' | 'unknown_pack' | 'unknown_unit' {
  const seen = new Set<string>()
  for (let pack = start; ;) {
    if (seen.has(pack.id)) return 'cycle'
    seen.add(pack.id)
    if (typeof pack.of === 'string') return isStandardUnit(pack.of) ? pack.of : 'unknown_unit'
    const next = packs.get(pack.of.pack)
    if (!next) return 'unknown_pack'
    pack = next
  }
}
