import { compareDecimal, newId, parseNumber } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { DECIMAL_MAX_LENGTH, zBusinessDate, zBusinessMonth, zDecimal, zUuid } from './primitives'

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

  it('agrees with parseNumber (@bizcost/domain), which reads what people type', () => {
    // Every value parseNumber returns is accepted unchanged.
    for (const typed of ['١٬٢٣٤٫٥', '1,234.50', '\u221272', '\u061c-١٢', '007.500', '-0']) {
      const parsed = parseNumber(typed)
      if (!parsed.ok) throw new Error(`parseNumber refused "${typed}"`)
      expect(zDecimal.parse(parsed.value)).toBe(parsed.value)
    }
    // Every value zDecimal accepts reads to the same number.
    for (const wire of ['-0.125', '  42 ', '١٢٫٥', '0012.50', '٠']) {
      const parsed = parseNumber(wire)
      if (!parsed.ok) throw new Error(`parseNumber refused "${wire}"`)
      expect(compareDecimal(parsed.value, zDecimal.parse(wire))).toBe(0)
    }
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

describe('zBusinessMonth', () => {
  it('reads YYYY-MM, Arabic-Indic digits too, and nothing else', () => {
    expect(zBusinessMonth.parse('2026-09')).toBe('2026-09')
    expect(zBusinessMonth.parse(' ٢٠٢٦-١٠ ')).toBe('2026-10')
    for (const bad of ['2026-13', '2026-00', '2026-9', '2026-09-01', '26-09', '']) {
      expect(zBusinessMonth.safeParse(bad).success, bad).toBe(false)
    }
  })
})
