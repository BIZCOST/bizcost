import { DECIMAL_PATTERN, pow10, toDec } from './decimal'

// Branded decimal strings, one per kind of number (docs/DATA_MODEL.md §1.4). A brand stops a value of
// one kind from being passed where another is expected (a Quantity is not Money) at compile time;
// at run time they are plain decimal strings, exactly as they travel on the wire.
//
// Brands say what a value is, not how it is printed: '72', '72.00' and '72.0000' (Postgres) are all
// valid Money. Compare values with compareDecimal, never with ===.

declare const kindTag: unique symbol
type DecimalOfKind<K extends string> = string & { readonly [kindTag]: K }

/** A document amount or price (numeric(20,4)): unit price, line total, VAT. */
export type Money = DecimalOfKind<'money'>
/** A quantity (numeric(24,6)): purchase qty, recipe qty, stock. May be negative (stock). */
export type Quantity = DecimalOfKind<'quantity'>
/** A cost per unit (numeric(28,12)): cost per base unit, weighted-average cost. Never rounded. */
export type UnitCost = DecimalOfKind<'unitCost'>
/** A cost-engine amount (numeric(28,12)): recipe line cost, stock value, cost of usage. Never rounded. */
export type CostAmount = DecimalOfKind<'costAmount'>
/** A percentage (numeric(9,6)), where 5 means 5 %: VAT rate, discount, tolerance. */
export type Percent = DecimalOfKind<'percent'>

/** Postgres column (precision, scale) of each kind; the domain never produces more decimals. */
export const DECIMAL_COLUMNS = {
  money: { precision: 20, scale: 4 },
  quantity: { precision: 24, scale: 6 },
  unitCost: { precision: 28, scale: 12 },
  costAmount: { precision: 28, scale: 12 },
  percent: { precision: 9, scale: 6 },
} as const

export type DecimalKind = keyof typeof DECIMAL_COLUMNS

/** The branded type of each kind. */
export interface DecimalKinds {
  money: Money
  quantity: Quantity
  unitCost: UnitCost
  costAmount: CostAmount
  percent: Percent
}

/** Decimals kept by the cost engine: the scale of numeric(28,12). */
export const COST_SCALE = DECIMAL_COLUMNS.unitCost.scale
/** Decimals kept for quantities: the scale of numeric(24,6). */
export const QUANTITY_SCALE = DECIMAL_COLUMNS.quantity.scale

export type DecimalCheckError = 'invalid' | 'too_many_decimals' | 'too_large'

/**
 * Checks a wire-form decimal string against a kind's column: 'invalid' (not a decimal string),
 * 'too_many_decimals' (more significant decimals than the column's scale; trailing zeros are fine)
 * or 'too_large' (more integer digits than precision − scale). null when it fits.
 */
export function checkDecimal(value: string, kind: DecimalKind): DecimalCheckError | null {
  if (!DECIMAL_PATTERN.test(value)) return 'invalid'
  const { precision, scale } = DECIMAL_COLUMNS[kind]
  const decimal = toDec(value)
  if (decimal.decimalPlaces() > scale) return 'too_many_decimals'
  if (decimal.abs().gte(pow10(precision - scale))) return 'too_large'
  return null
}

/** The value as the branded kind. Throws RangeError when checkDecimal finds a problem. */
export function asDecimal<K extends DecimalKind>(kind: K, value: string): DecimalKinds[K] {
  const error = checkDecimal(value, kind)
  if (error) throw new RangeError(`Not a valid ${kind} (${error}): "${value}"`)
  return value as DecimalKinds[K]
}

/** A wire-form string as Money (throws RangeError when it does not fit numeric(20,4)). */
export const asMoney = (value: string): Money => asDecimal('money', value)
/** A wire-form string as a Quantity (throws RangeError when it does not fit numeric(24,6)). */
export const asQuantity = (value: string): Quantity => asDecimal('quantity', value)
/** A wire-form string as a UnitCost (throws RangeError when it does not fit numeric(28,12)). */
export const asUnitCost = (value: string): UnitCost => asDecimal('unitCost', value)
/** A wire-form string as a CostAmount (throws RangeError when it does not fit numeric(28,12)). */
export const asCostAmount = (value: string): CostAmount => asDecimal('costAmount', value)
/** A wire-form string as a Percent (throws RangeError when it does not fit numeric(9,6)). */
export const asPercent = (value: string): Percent => asDecimal('percent', value)
