import { describe, expect, it } from 'vitest'
import { businessDisplayName } from './display-name'

describe('businessDisplayName', () => {
  const both = { legalName: 'Moon Café LLC', legalNameAr: 'مقهى القمر ذ.م.م' }

  it('shows the Arabic legal name in Arabic when the business has one', () => {
    expect(businessDisplayName(both, 'ar')).toBe('مقهى القمر ذ.م.م')
  })

  it('always shows the legal name in English', () => {
    expect(businessDisplayName(both, 'en')).toBe('Moon Café LLC')
    expect(businessDisplayName({ legalName: 'Moon Café LLC', legalNameAr: null }, 'en')).toBe(
      'Moon Café LLC',
    )
  })

  it('falls back to the legal name in Arabic without an Arabic name', () => {
    for (const legalNameAr of [null, undefined, '', '   ']) {
      expect(businessDisplayName({ legalName: 'Moon Café LLC', legalNameAr }, 'ar')).toBe(
        'Moon Café LLC',
      )
    }
    expect(businessDisplayName({ legalName: 'Moon Café LLC' }, 'ar')).toBe('Moon Café LLC')
  })

  it('keeps a legal name that is already in Arabic', () => {
    expect(businessDisplayName({ legalName: 'مخبز النور', legalNameAr: null }, 'ar')).toBe(
      'مخبز النور',
    )
    expect(businessDisplayName({ legalName: 'مخبز النور', legalNameAr: null }, 'en')).toBe(
      'مخبز النور',
    )
  })

  it('shows the Arabic name without surrounding spaces', () => {
    expect(businessDisplayName({ legalName: 'Moon Café', legalNameAr: ' مقهى القمر ' }, 'ar')).toBe(
      'مقهى القمر',
    )
  })
})
