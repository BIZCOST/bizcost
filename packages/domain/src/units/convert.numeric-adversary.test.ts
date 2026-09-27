import { describe, expect, it } from 'vitest'
import { checkDecimal, type Quantity } from '../numbers/kinds'
import { toBase, unitFactor } from './convert'
import { validateMaterialUnits, type MaterialUnits } from './materials'

// Numeric adversary (M2 Step 1 review), now a regression test: each case failed before the fix
// (conversions now carry an exact fraction and divide once).

// A valid material (validateMaterialUnits returns []): printed pieces, the machine makes 30 an hour.
// A cross factor whose unit is 'min' or 'h' is divided by 60 or 3600, which no decimal holds exactly.
const PRINTS: MaterialUnits = {
  dimension: 'count',
  crossFactors: [{ unit: 'h', qty: '30', of: 'piece' }],
}

describe('cross factors through time units', () => {
  it('is a valid material', () => {
    expect(validateMaterialUnits(PRINTS)).toEqual([])
  })

  it('unitFactor fits numeric(28,12) and zDecimal (40 chars), as documented', () => {
    const factor = unitFactor('s', PRINTS)
    // Before the fix: '0.0083333…3' (68 characters, 64 significant digits, truncated): not exact,
    // too_many_decimals for numeric(28,12), and longer than DECIMAL_MAX_LENGTH (40).
    expect(factor.length).toBeLessThanOrEqual(40)
    expect(checkDecimal(factor, 'unitCost')).toBeNull()
  })

  it('rounds a half-way quantity half up (no double rounding)', () => {
    // 0.00006 s × 30/3600 = 0.0000005 exactly, which rounds half up to 0.000001 at 6 decimals.
    // Before the fix: '0'. The factor 1/120 was truncated at 64 digits before the multiplication, so
    // the product landed just below the tie.
    expect(toBase('0.00006' as Quantity, 's', PRINTS)).toBe('0.000001')
    expect(toBase('-0.00006' as Quantity, 's', PRINTS)).toBe('-0.000001')
  })
})
