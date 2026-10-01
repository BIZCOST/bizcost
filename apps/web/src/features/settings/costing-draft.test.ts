import type { CurrencyCode } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { readSetting, sameAmount, settingsChange } from './costing-draft'

// Settings → How costs are worked out: the owner's hourly rate as typed, and what
// productCost.updateSettings is sent (only when it changed; empty clears). Running costs need no
// setting (D-202).

const AED = 'AED' as CurrencyCode
const KWD = 'KWD' as CurrencyCode
const NOTHING_SAVED = { hourlyRate: null }

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

  it('sends the hourly rate when it changed; an emptied field clears it', () => {
    expect(settingsChange({ hourlyRate: '45' }, NOTHING_SAVED, AED).input).toEqual({
      ownerHourlyRate: '45',
    })
    expect(settingsChange({ hourlyRate: '' }, { hourlyRate: '45' }, AED).input).toEqual({
      ownerHourlyRate: null,
    })
    // Nothing changed: nothing to send.
    expect(settingsChange({ hourlyRate: '45.00' }, { hourlyRate: '45' }, AED).input).toBeNull()
    expect(settingsChange({ hourlyRate: '' }, NOTHING_SAVED, AED).input).toBeNull()
  })

  it('says when the rate does not read, and sends nothing then', () => {
    const change = settingsChange({ hourlyRate: '0' }, NOTHING_SAVED, AED)
    expect(change.input).toBeNull()
    expect(change.errors.hourlyRate?.key).toBe('catalog.numbers.positive')
  })
})
