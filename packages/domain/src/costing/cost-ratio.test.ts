import { describe, expect, it } from 'vitest'
import { roundForDisplay } from '../numbers/rounding'
import { costRatio } from './cost-ratio'

describe('costRatio (one division, one rounding, 12 decimals)', () => {
  it('the owner’s milk: AED 1000 for 150 000 ml is 6.666666666667 per L, shown 6.67', () => {
    const perLitre = costRatio(['1000', '1000'], ['150000'])
    expect(perLitre).toBe('6.666666666667')
    expect(roundForDisplay(perLitre!, 2)).toBe('6.67')
    // Per ml, rounded once: not the per-litre value divided again.
    expect(costRatio(['1000'], ['150000'])).toBe('0.006666666667')
    expect(costRatio(['300', '1000'], ['50000'])).toBe('6')
  })

  it('per purchase unit: value × base units per unit ÷ (quantity left × units bought)', () => {
    // 10 cartons of 12 000 ml for AED 720, 2 returned (AED 144 back): AED 72 a carton still.
    expect(costRatio(['576', '120000'], ['96000', '10'])).toBe('72')
  })

  it('null when there is nothing to divide by', () => {
    expect(costRatio(['5'], ['0'])).toBeNull()
    expect(costRatio(['5'], ['10', '-1'])).toBeNull()
  })
})
