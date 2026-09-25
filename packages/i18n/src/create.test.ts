import { appErrorI18nKey } from '@bizcost/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createI18n } from './create'
import type { I18nKey } from './types'

describe('createI18n', () => {
  it('returns a new instance on every call, so requests never share a language', () => {
    const ar = createI18n({ locale: 'ar' })
    const en = createI18n({ locale: 'en' })
    expect(ar).not.toBe(en)
    expect(ar.language).toBe('ar')
    expect(en.language).toBe('en')
    expect(ar.t('auth.login.title')).toBe('تسجيل الدخول')
    expect(en.t('auth.login.title')).toBe('Sign in')
  })

  it('resolves `<namespace>.<path>` keys, API error keys and unprefixed common keys', () => {
    const i18n = createI18n({ locale: 'en' })
    expect(i18n.t('errors.not_found')).toBe("We couldn't find what you're looking for.")
    expect(i18n.t(appErrorI18nKey('forbidden'))).toBe("You don't have access to this.")
    expect(i18n.t('common.actions.save')).toBe('Save')
    expect(i18n.t('actions.save')).toBe('Save')
    expect(i18n.t('auth.errors.codeInvalid')).toMatch(/^This code is wrong/)
  })

  it('interpolates without HTML escaping (React escapes)', () => {
    const i18n = createI18n({ locale: 'en' })
    expect(i18n.t('common.home.greeting', { name: 'Sara & Co' })).toBe('Hello, Sara & Co')
  })

  it('uses the six Arabic plural forms', () => {
    const i18n = createI18n({ locale: 'ar' })
    const say = (count: number) => i18n.t('auth.verify.resendIn', { count })
    expect(say(0)).toBe('يمكنك طلب رمز جديد بعد 0 ثانية.')
    expect(say(1)).toBe('يمكنك طلب رمز جديد بعد ثانية واحدة.')
    expect(say(2)).toBe('يمكنك طلب رمز جديد بعد ثانيتين.')
    expect(say(3)).toBe('يمكنك طلب رمز جديد بعد 3 ثوانٍ.')
    expect(say(11)).toBe('يمكنك طلب رمز جديد بعد 11 ثانية.')
    expect(say(100)).toBe('يمكنك طلب رمز جديد بعد 100 ثانية.')
  })

  it('uses the English plural forms', () => {
    const i18n = createI18n({ locale: 'en' })
    expect(i18n.t('auth.verify.resendIn', { count: 1 })).toBe(
      'You can ask for a new code in 1 second.',
    )
    expect(i18n.t('auth.validation.passwordTooShort', { count: 8 })).toBe(
      'Use at least 8 characters.',
    )
  })

  it('loads only the requested namespaces (plus common)', () => {
    const i18n = createI18n({ locale: 'ar', namespaces: ['auth'] })
    expect(i18n.hasResourceBundle('ar', 'auth')).toBe(true)
    expect(i18n.hasResourceBundle('ar', 'common')).toBe(true)
    expect(i18n.hasResourceBundle('ar', 'account')).toBe(false)
    expect(i18n.hasResourceBundle('en', 'auth')).toBe(true)
  })

  it('types keys against the English messages', () => {
    const i18n = createI18n({ locale: 'en' })
    // @ts-expect-error unknown key
    i18n.t('auth.login.nope')
    expectTypeOf<'auth.verify.resendIn'>().toExtend<I18nKey>()
    expectTypeOf<'errors.internal'>().toExtend<I18nKey>()
    expectTypeOf<'auth.verify.resendIn_other'>().not.toExtend<I18nKey>()
    expectTypeOf<'auth.login'>().not.toExtend<I18nKey>()
  })
})
