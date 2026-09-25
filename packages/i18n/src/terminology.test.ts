import { TERMINOLOGY_PROFILES } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { createI18n } from './create'
import { terminologyKey } from './terminology'

describe('terminologyKey', () => {
  it('returns the overlay of the profile when there is one', () => {
    expect(terminologyKey('modules.materials.name', 'food')).toBe('modules.materials.name_food')
    expect(terminologyKey('modules.materials.name', 'factory')).toBe(
      'modules.materials.name_factory',
    )
    expect(terminologyKey('modules.products.name', 'projects')).toBe(
      'modules.products.name_projects',
    )
    expect(terminologyKey('setup.jobs.name', 'maker')).toBe('setup.jobs.name_maker')
  })

  it('keeps the key without an overlay or a profile', () => {
    expect(terminologyKey('modules.materials.name', 'maker')).toBe('modules.materials.name')
    expect(terminologyKey('modules.materials.name', 'general')).toBe('modules.materials.name')
    expect(terminologyKey('setup.jobs.name', null)).toBe('setup.jobs.name')
    expect(terminologyKey('setup.jobs.name', undefined)).toBe('setup.jobs.name')
  })

  it('names the same message as i18next context', () => {
    const i18n = createI18n({ locale: 'ar' })
    for (const profile of TERMINOLOGY_PROFILES) {
      expect(i18n.t(terminologyKey('modules.materials.name', profile))).toBe(
        i18n.t('modules.materials.name', { context: profile } as never),
      )
    }
    expect(i18n.t(terminologyKey('modules.materials.name', 'food'))).toBe('المكونات')
  })
})
