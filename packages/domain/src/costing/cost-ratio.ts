import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type UnitCost } from '../numbers/kinds'

// A cost per unit from sums (D-107: an exact product divided once, rounded once, to 12 decimals;
// never to the currency). The material cost view (M2 Step 3, D-115) reads Σ value and Σ base quantity
// from the ledger in SQL and divides here: per base unit (value ÷ qty), per the unit the business
// counts the material in (value × base units per unit ÷ qty: 1000 ÷ 150 000 ml × 1000 = 6.666666666667
// per L, not the per-ml average rounded first), and per purchase unit.

/**
 * The exact product of `numerators` divided by the exact product of `denominators`, rounded half away
 * from zero to 12 decimals; null when the denominator is not more than zero (nothing to divide by).
 */
export function costRatio(
  numerators: readonly string[],
  denominators: readonly string[],
): UnitCost | null {
  const denominator = exactProduct(denominators.map(toDec))
  if (!denominator.gt(0)) return null
  const numerator = exactProduct(numerators.map(toDec))
  return plain(roundHalfUp(numerator.dividedBy(denominator), COST_SCALE)) as UnitCost
}
