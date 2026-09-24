import { newId } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { DECIMAL_MAX_LENGTH, zBusinessDate, zDecimal, zUuid } from './primitives'

describe('zDecimal', () => {
  it('accepts negative values and trims surrounding whitespace', () => {
    expect(zDecimal.parse('-0.125')).toBe('-0.125')
    expect(zDecimal.parse('  42 ')).toBe('42')
  })

  it('rejects a leading "+", bare dot forms and group separators', () => {
    for (const value of ['+5', '.5', '5.', '-.5', '1,000', '1٬000', '1 000', '- 5']) {
      expect(zDecimal.safeParse(value).success).toBe(false)
    }
  })

  it('rejects strings longer than DECIMAL_MAX_LENGTH', () => {
    expect(zDecimal.safeParse('9'.repeat(DECIMAL_MAX_LENGTH)).success).toBe(true)
    expect(zDecimal.safeParse('9'.repeat(DECIMAL_MAX_LENGTH + 1)).success).toBe(false)
  })

  it('stays usable as a shared instance inside other schemas', () => {
    expect(zDecimal.nullable().parse(null)).toBeNull()
    expect(zDecimal.parse('1')).toBe('1')
  })
})

describe('zUuid', () => {
  it('accepts any UUID version (auth users are v4, rows v7) and outputs lowercase', () => {
    const id = newId()
    expect(zUuid.parse(id.toUpperCase())).toBe(id)
    expect(zUuid.parse('00000000-0000-0000-0000-000000000001')).toBe(
      '00000000-0000-0000-0000-000000000001',
    )
  })
})

describe('zBusinessDate', () => {
  it('outputs the same YYYY-MM-DD string', () => {
    expect(zBusinessDate.parse('2026-09-25')).toBe('2026-09-25')
  })
})
