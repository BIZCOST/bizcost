import { TERMINOLOGY_PROFILES } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { createI18n } from './create'
import { createI18nInstance, hasKey } from './instance'
import { hasMessage, pickMessages } from './resources'
import { terminologyKey } from './terminology'

const english = (key: string) => hasMessage('en', key)

describe('terminologyKey', () => {
  it('returns the overlay of the profile when there is one', () => {
    expect(terminologyKey('modules.materials.name', 'food', english)).toBe(
      'modules.materials.name_food',
    )
    expect(terminologyKey('modules.materials.name', 'factory', english)).toBe(
      'modules.materials.name_factory',
    )
    expect(terminologyKey('modules.products.name', 'projects', english)).toBe(
      'modules.products.name_projects',
    )
    expect(terminologyKey('setup.jobs.name', 'maker', english)).toBe('setup.jobs.name_maker')
  })

  it('keeps the key without an overlay or a profile', () => {
    expect(terminologyKey('modules.materials.name', 'maker', english)).toBe(
      'modules.materials.name',
    )
    expect(terminologyKey('modules.materials.name', 'general', english)).toBe(
      'modules.materials.name',
    )
    expect(terminologyKey('setup.jobs.name', null, english)).toBe('setup.jobs.name')
    expect(terminologyKey('setup.jobs.name', undefined, english)).toBe('setup.jobs.name')
  })

  it('names the same message as i18next context', () => {
    const i18n = createI18n({ locale: 'ar' })
    for (const profile of TERMINOLOGY_PROFILES) {
      expect(i18n.t(terminologyKey('modules.materials.name', profile, english))).toBe(
        i18n.t('modules.materials.name', { context: profile } as never),
      )
    }
    expect(i18n.t(terminologyKey('modules.materials.name', 'food', english))).toBe('المكونات')
  })

  it('works with the part of the messages a page holds', () => {
    const i18n = createI18nInstance({
      locale: 'en',
      messages: { en: pickMessages('en', [{ namespace: 'setup', paths: ['cap'] }]) },
    })
    const has = (key: string) => hasKey(i18n, key)
    expect(terminologyKey('setup.cap.jobs_and_tasks.on', 'maker', has)).toBe(
      'setup.cap.jobs_and_tasks.on_maker',
    )
    expect(terminologyKey('setup.jobs.name', 'maker', has)).toBe('setup.jobs.name')
  })
})
