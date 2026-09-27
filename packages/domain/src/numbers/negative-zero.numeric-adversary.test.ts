import { describe, expect, it } from 'vitest'
import { computeLine, lineError, type LineInput } from '../documents/line'
import { costPerBaseUnit } from '../units/convert'
import type { Money, Percent, Quantity } from './kinds'

// Numeric adversary (M2 Step 1 review), now a regression test: each case failed before the fix.
//
// zDecimal (@bizcost/contracts, the API's only decimal gate) accepts "-0" and "-0.00" and passes
// them on unchanged (it does not canonicalize), and CSV/spreadsheet imports often carry "-0.00".
// decimal.js reports Decimal('-0').isNeg() === true, so the domain tests signs with lt(0) / gt(0),
// never isNeg(): a zero written "-0" is zero everywhere, as wacReceive already treated it.
// (The review's third case, solveRoundAmount, left with Make Round Amount: a Phase 3 feature.)

describe('negative zero is zero', () => {
  it('lineError / computeLine accept a zero price, quantity, rate and discount written "-0"', () => {
    const input: LineInput = {
      qty: '-0' as Quantity,
      unitPrice: '-0.00' as Money,
      vatRate: '-0' as Percent,
      discount: { percent: '-0' as Percent },
    }
    expect(lineError(input, 'AED')).toBeNull()
    expect(computeLine(input, 'AED').total).toBe('0.00')
  })

  it('costPerBaseUnit accepts a zero price written "-0.00" (free goods)', () => {
    expect(costPerBaseUnit('-0.00' as Money, '1' as Quantity, 'kg', { dimension: 'mass' })).toBe(
      '0',
    )
  })
})
