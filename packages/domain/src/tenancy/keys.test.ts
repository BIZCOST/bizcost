import { describe, expect, it } from 'vitest'
import { isLocale, LOCALES } from './keys'

describe('isLocale', () => {
  it('accepts only the stored locales', () => {
    expect(LOCALES).toEqual(['en', 'ar'])
    expect(isLocale('en')).toBe(true)
    expect(isLocale('ar')).toBe(true)
    expect(isLocale('AR')).toBe(false)
    expect(isLocale('ar-AE')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
})
