import { describe, expect, it } from 'vitest'
import { normalizeDigits } from './digits'

describe('normalizeDigits', () => {
  it('converts Arabic-Indic digits', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
  })

  it('converts Extended Arabic-Indic (Persian) digits', () => {
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
  })

  it('handles mixed input and keeps other characters', () => {
    expect(normalizeDigits('AED ١٢.5 - ۳')).toBe('AED 12.5 - 3')
  })

  it('leaves ASCII untouched', () => {
    expect(normalizeDigits('100200300')).toBe('100200300')
  })
})
