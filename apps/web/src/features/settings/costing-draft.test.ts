import type { CurrencyCode } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { readSetting, sameAmount, settingsChange } from './costing-draft'

// Settings → How costs are worked out: the estimate of monthly purchases and the hourly rate, as
// typed, and what productCost.updateSettings is sent (only what changed; empty clears).

const AED = 'AED' as CurrencyCode
const KWD = 'KWD' as CurrencyCode
const NOTHING_SAVED = { estimate: null, hourlyRate: null }

describe('the costing settings as typed', () => {
  it('reads an amount in either language, above zero, with the currency decimals', () => {
    expect(readSetting('30,000', AED)).toEqual({ ok: true, value: '30000' })
    expect(readSetting('٤٥٫٥', AED)).toEqual({ ok: true, value: '45.5' })
    expect(readSetting('  ', AED)).toEqual({ ok: true, value: null })
    expect(readSetting('0', AED)).toMatchObject({
      ok: false,
      error: { key: 'catalog.numbers.positive' },
    })
    expect(readSetting('-5', AED)).toMatchObject({ ok: false })
    expect(readSetting('12.345', AED)).toMatchObject({
      ok: false,
      error: { key: 'catalog.numbers.tooManyDecimals' },
    })
    expect(readSetting('12.345', KWD)).toEqual({ ok: true, value: '12.345' })
    expect(readSetting('abc', AED)).toMatchObject({
      ok: false,
      error: { key: 'catalog.numbers.invalid' },
    })
  })

  it('compares amounts as numbers', () => {
    expect(sameAmount('30000', '30000.00')).toBe(true)
    expect(sameAmount(null, null)).toBe(true)
    expect(sameAmount('1', null)).toBe(false)
    expect(sameAmount('45', '45.5')).toBe(false)
  })

  it('sends only what changed; an emptied field clears it', () => {
    expect(settingsChange({ estimate: '30000' }, NOTHING_SAVED, AED).input).toEqual({
      estimatedMonthlyPurchases: '30000',
    })
    expect(
      settingsChange(
        { estimate: '30,000.00', hourlyRate: '45' },
        { estimate: '30000', hourlyRate: null },
        AED,
      ).input,
    ).toEqual({ ownerHourlyRate: '45' })
    expect(
      settingsChange({ estimate: '' }, { estimate: '30000', hourlyRate: '45' }, AED).input,
    ).toEqual({ estimatedMonthlyPurchases: null })
    // Nothing changed: nothing to send.
    expect(
      settingsChange(
        { estimate: '2000', hourlyRate: '' },
        { estimate: '2000', hourlyRate: null },
        AED,
      ).input,
    ).toBeNull()
  })

  it('says which field does not read, and sends nothing then', () => {
    const change = settingsChange({ estimate: '0', hourlyRate: '45' }, NOTHING_SAVED, AED)
    expect(change.input).toBeNull()
    expect(change.errors.estimate?.key).toBe('catalog.numbers.positive')
    expect(change.errors.hourlyRate).toBeUndefined()
  })
})
