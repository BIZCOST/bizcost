import { describe, expect, it } from 'vitest'
import { isLocale, isTerminologyProfile, LOCALES, TERMINOLOGY_PROFILES } from './keys'

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

describe('isTerminologyProfile', () => {
  it('accepts only the six profiles', () => {
    expect(TERMINOLOGY_PROFILES).toEqual([
      'general',
      'food',
      'maker',
      'workshop',
      'factory',
      'projects',
    ])
    for (const profile of TERMINOLOGY_PROFILES) expect(isTerminologyProfile(profile)).toBe(true)
    expect(isTerminologyProfile('retail')).toBe(false)
    expect(isTerminologyProfile(undefined)).toBe(false)
  })
})
