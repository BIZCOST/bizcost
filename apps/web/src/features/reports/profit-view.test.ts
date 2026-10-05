import type { RealProfitReason } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  completenessShare,
  isLoss,
  partAmount,
  partsShown,
  percentOfSales,
  withoutMinus,
} from './profit-view'

// Which parts of real profit Reports → Real profit shows (M3 Step 3): only those the business has.

const sum = (patch: Partial<Parameters<typeof partsShown>[0][number]> = {}) => ({
  materials: '0',
  fees: '0',
  deliveryCost: '0',
  deliveryCharged: '0',
  runningCosts: '0',
  ownerTime: '0',
  reasons: [] as RealProfitReason[],
  ...patch,
})

describe('the parts of real profit a business has', () => {
  it('a café without deliveries or apps: materials and running costs', () => {
    expect(
      partsShown([sum({ materials: '4800', runningCosts: '20000' })], {
        runningCounted: true,
        ownerTime: false,
      }),
    ).toEqual(['materials', 'running'])
  })

  it('the home baker: materials, delivery charged or not yet costed, her time', () => {
    expect(
      partsShown(
        [
          sum({ materials: '42.26', ownerTime: '105' }),
          sum({ deliveryCharged: '15', reasons: ['delivery_cost_not_entered'] }),
        ],
        { runningCounted: true, ownerTime: true },
      ),
    ).toEqual(['materials', 'delivery', 'running', 'time'])
  })

  it('app fees once any sale carries them, or is still before them', () => {
    expect(
      partsShown([sum({ reasons: ['fees_not_entered'] })], {
        runningCounted: false,
        ownerTime: false,
      }),
    ).toEqual(['fees'])
    expect(
      partsShown([sum({ fees: '165.71' })], { runningCounted: false, ownerTime: false }),
    ).toEqual(['fees'])
  })

  it('never the owner’s time with a team, nor what is withheld', () => {
    expect(
      partsShown([sum({ ownerTime: '300', materials: null })], {
        runningCounted: false,
        ownerTime: false,
      }),
    ).toEqual([])
    expect(partAmount(sum({ deliveryCost: null }), 'delivery')).toBeNull()
  })

  it('each part as a share of the sales; a loss said without its minus', () => {
    expect(percentOfSales('20000', '80000')).toBe('25')
    expect(percentOfSales('5', '0')).toBeNull()
    expect(percentOfSales(null, '100')).toBeNull()
    expect(isLoss('-306.28')).toBe(true)
    expect(isLoss('0')).toBe(false)
    expect(withoutMinus('-306.28')).toBe('306.28')
  })
})

describe('how complete the costs are, in words (D-250)', () => {
  it('never says 100% while something is missing, nor 0% while something is complete', () => {
    // The baker: AED 15.00 of AED 3,565.00 without a delivery cost: 99.58% is "more than 99%".
    expect(completenessShare('99.579242636746', false)).toEqual({
      words: 'percentAlmost',
      percent: '99',
    })
    expect(completenessShare('99.4', false)).toEqual({ words: 'percent', percent: '99.4' })
    expect(completenessShare('0.2', false)).toEqual({ words: 'percentLittle', percent: '1' })
    expect(completenessShare('0', false)).toEqual({ words: 'percent', percent: '0' })
    expect(completenessShare('100', true)).toEqual({ words: 'percent', percent: '100' })
  })
})
