import { describe, expect, it } from 'vitest'
import { addMessages, createI18nInstance, hasKey } from './instance'
import { NAMESPACES } from './namespaces'
import { en, pickMessages, resources } from './resources'

// The browser's instance (D-092): built from the messages the server passes for the page, one
// language only, and given more as the user opens other pages.

describe('pickMessages', () => {
  it('gives whole namespaces of one language', () => {
    const picked = pickMessages('ar', ['common', 'auth'])
    expect(Object.keys(picked)).toEqual(['common', 'auth'])
    expect(picked.auth).toBe(resources.ar.auth)
  })

  it('gives parts of a namespace: branches, and messages with their variants', () => {
    const picked = pickMessages('en', [
      { namespace: 'setup', paths: ['cap', 'review.groups.about', 'jobs.name', 'no.such.path'] },
    ])
    const setup = picked.setup as Record<string, Record<string, unknown>>
    expect(Object.keys(setup).sort()).toEqual(['cap', 'jobs', 'review'])
    expect(setup.cap).toEqual(resources.en.setup.cap)
    expect(setup.review).toEqual({ groups: { about: 'About your business' } })
    // The message and its overlays, not its siblings.
    expect(Object.keys(setup.jobs!).sort()).toEqual(['name', 'name_maker'])
  })

  it('merges a whole namespace with a part of it', () => {
    const picked = pickMessages('en', [{ namespace: 'setup', paths: ['cap'] }, 'setup'])
    expect(picked.setup).toEqual(resources.en.setup)
  })
})

describe('createI18nInstance', () => {
  it('holds only the messages given, and knows every namespace', () => {
    const i18n = createI18nInstance({
      locale: 'ar',
      messages: { ar: pickMessages('ar', ['common']) },
    })
    expect(i18n.t('actions.save')).toBe('حفظ')
    expect(i18n.hasResourceBundle('ar', 'auth')).toBe(false)
    expect(i18n.hasResourceBundle('en', 'common')).toBe(false)
    // A key of a namespace not given yet stays a key (not a common key named "auth…").
    expect(i18n.t('auth.login.title')).toBe('login.title')
    expect(i18n.options.ns).toEqual([...NAMESPACES])
  })

  it('takes more messages later, merging parts of a namespace', () => {
    const i18n = createI18nInstance({
      locale: 'en',
      messages: { en: pickMessages('en', ['common']) },
    })
    addMessages(i18n, 'en', pickMessages('en', [{ namespace: 'setup', paths: ['cap'] }]))
    expect(i18n.t('setup.cap.has_team.on')).toBe(en.setup.cap.has_team.on)
    expect(hasKey(i18n, 'setup.title')).toBe(false)
    addMessages(i18n, 'en', pickMessages('en', ['setup']))
    expect(hasKey(i18n, 'setup.title')).toBe(true)
    expect(i18n.t('setup.cap.has_team.on')).toBe(en.setup.cap.has_team.on)
    // Adding the same messages again changes nothing.
    addMessages(i18n, 'en', pickMessages('en', ['setup']))
    expect(i18n.t('setup.title')).toBe(resources.en.setup.title)
  })

  it('finds keys that have plural forms only', () => {
    const i18n = createI18nInstance({
      locale: 'ar',
      messages: { ar: pickMessages('ar', ['auth']) },
    })
    expect(hasKey(i18n, 'auth.verify.resendIn')).toBe(true)
    expect(i18n.t('auth.verify.resendIn', { count: 2 })).toBe('يمكنك طلب رمز جديد بعد ثانيتين.')
    expect(hasKey(i18n, 'auth.verify.nope')).toBe(false)
  })
})
