import { readFileSync } from 'node:fs'
import {
  AUTH_OTP_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_RESEND_COOLDOWN_SECONDS,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
} from '@bizcost/contracts'
import { hasMessage, LOCALES } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import type * as z from 'zod/mini'
import { isCompleteCode, normalizeCode, secondsUntil } from './code'
import {
  changeEmailSchema,
  changePasswordSchema,
  codeFormSchema,
  emailCodesSchema,
  formMessage,
  newPasswordSchema,
  passwordChecks,
  profileFormSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from './forms'

/** The message shown per field: the first issue, as the form resolver picks it. */
function messages(schema: z.ZodMiniType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value)
  if (result.success) return {}
  const out: Record<string, string> = {}
  for (const issue of result.error.issues) out[issue.path.join('.')] ??= issue.message
  return out
}

describe('form schemas', () => {
  it('trim and lowercase the email', () => {
    expect(signInSchema.parse({ email: '  Sara@Example.COM ', password: 'x' })).toEqual({
      email: 'sara@example.com',
      password: 'x',
    })
  })

  it('use i18n keys as messages', () => {
    expect(messages(signInSchema, { email: '', password: '' })).toEqual({
      email: 'auth.validation.emailRequired',
      password: 'auth.validation.passwordRequired',
    })
    expect(messages(signUpSchema, { email: 'nope', password: 'short' })).toEqual({
      email: 'auth.validation.emailInvalid',
      password: 'auth.validation.passwordTooShort',
    })
    expect(messages(changeEmailSchema, { newEmail: 'a@b' })).toEqual({
      newEmail: 'auth.validation.emailInvalid',
    })
  })

  it('only require the password to sign in (older passwords keep working)', () => {
    for (const password of ['x', 'abcdefgh', '12345678', 'كلمة-مرور']) {
      expect(messages(signInSchema, { email: 'a@b.co', password })).toEqual({})
    }
  })

  it('limit new passwords to 72 UTF-8 bytes (bcrypt)', () => {
    const ok = { email: 'a@b.co', password: `${'a'.repeat(71)}1` }
    expect(signUpSchema.safeParse(ok).success).toBe(true)
    expect(messages(signUpSchema, { ...ok, password: `${'ب'.repeat(36)}a1` })).toEqual({
      password: 'auth.validation.passwordTooLong',
    })
  })

  it('normalize codes and require every digit', () => {
    expect(codeFormSchema.parse({ code: '١٢٣-٤٥٦' })).toEqual({ code: '123456' })
    expect(messages(codeFormSchema, { code: '12345' })).toEqual({
      code: 'auth.validation.codeIncomplete',
    })
    expect(emailCodesSchema.safeParse({ currentCode: '111111', newCode: '۲۲۲۲۲۲' }).data).toEqual({
      currentCode: '111111',
      newCode: '222222',
    })
  })

  it('trim the display name and keep it within the API limit', () => {
    expect(profileFormSchema.parse({ displayName: '  Sara  ' })).toEqual({ displayName: 'Sara' })
    expect(messages(profileFormSchema, { displayName: '   ' })).toEqual({
      displayName: 'account.profile.displayNameRequired',
    })
    const tooLong = 'x'.repeat(PROFILE_DISPLAY_NAME_MAX_LENGTH + 1)
    expect(messages(profileFormSchema, { displayName: tooLong })).toEqual({
      displayName: 'account.profile.displayNameTooLong',
    })
    expect(formMessage('account.profile.displayNameTooLong')).toEqual({
      key: 'account.profile.displayNameTooLong',
      values: { count: PROFILE_DISPLAY_NAME_MAX_LENGTH },
    })
  })

  it('require the new password twice', () => {
    const value = { password: 'long-enough-1', confirmPassword: 'long-enough-2' }
    expect(messages(resetPasswordSchema, { ...value, confirmPassword: value.password })).toEqual({})
    expect(messages(resetPasswordSchema, value)).toEqual({
      confirmPassword: 'auth.validation.passwordsDontMatch',
    })
    expect(messages(changePasswordSchema, { ...value, code: '12' })).toEqual({
      code: 'auth.validation.codeIncomplete',
      confirmPassword: 'auth.validation.passwordsDontMatch',
    })
  })

  it('only use messages that exist in both languages', () => {
    const keys = [
      'auth.validation.emailRequired',
      'auth.validation.emailInvalid',
      'auth.validation.passwordRequired',
      'auth.validation.passwordTooShort',
      'auth.validation.passwordTooLong',
      'auth.validation.passwordNeedsMix',
      'auth.validation.passwordsDontMatch',
      'auth.validation.codeIncomplete',
      'account.email.sameEmail',
      'account.profile.displayNameRequired',
      'account.profile.displayNameTooLong',
    ]
    for (const locale of LOCALES) {
      for (const key of keys) expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
    }
  })
})

describe('new password rule (D-072, the Auth server letters_digits rule)', () => {
  const error = (password: string) => messages(newPasswordSchema, password)['']

  it(`accepts ${AUTH_PASSWORD_MIN_LENGTH} characters with an ASCII letter and an ASCII digit`, () => {
    expect(AUTH_PASSWORD_MIN_LENGTH).toBe(8)
    expect(error('abcdef12')).toBeUndefined()
    expect(error('1234567a')).toBeUndefined()
    expect(error('ABCDEF12')).toBeUndefined() // uppercase letters count
    expect(error('Ab1-كلمة')).toBeUndefined() // other characters may be added
  })

  it('refuses 7 characters', () => {
    expect(error('abcde12')).toBe('auth.validation.passwordTooShort')
  })

  it('counts characters, not UTF-16 units or bytes, the same way as the checklist', () => {
    // 8 UTF-16 units and 14 bytes, but 5 characters: the checklist and the submit both refuse it.
    expect(error('a1😀😀😀')).toBe('auth.validation.passwordTooShort')
    expect(passwordChecks('a1😀😀😀').length).toBe(false)
    expect(error('a1😀😀😀😀😀😀')).toBeUndefined()
    // 7 characters in 11 bytes: the Auth server (it counts bytes) would take it, this rule does not.
    expect(error('ab1كلمة')).toBe('auth.validation.passwordTooShort')
    expect(passwordChecks('ab1كلمة').length).toBe(false)
  })

  it('refuses letters only or digits only', () => {
    expect(error('abcdefgh')).toBe('auth.validation.passwordNeedsMix')
    expect(error('ABCDEFGH')).toBe('auth.validation.passwordNeedsMix')
    expect(error('12345678')).toBe('auth.validation.passwordNeedsMix')
  })

  it('does not count Arabic-Indic digits or Arabic letters', () => {
    expect(error('٠١٢٣٤٥٦٧')).toBe('auth.validation.passwordNeedsMix')
    expect(error('abcdefg٣')).toBe('auth.validation.passwordNeedsMix')
    expect(error('abcdefg۳')).toBe('auth.validation.passwordNeedsMix')
    expect(error('كلمةمرور12')).toBe('auth.validation.passwordNeedsMix')
  })

  it('never changes the password (no digit or case normalization)', () => {
    expect(newPasswordSchema.parse('Abc-١٢٣-45')).toBe('Abc-١٢٣-45')
    expect(signUpSchema.parse({ email: 'a@b.co', password: ' AbCd123 ' }).password).toBe(
      ' AbCd123 ',
    )
  })

  it('applies to every new-password form', () => {
    const weak = 'abcdefgh'
    expect(messages(signUpSchema, { email: 'a@b.co', password: weak })).toEqual({
      password: 'auth.validation.passwordNeedsMix',
    })
    expect(messages(resetPasswordSchema, { password: weak, confirmPassword: weak })).toEqual({
      password: 'auth.validation.passwordNeedsMix',
    })
    expect(
      messages(changePasswordSchema, { code: '123456', password: weak, confirmPassword: weak }),
    ).toEqual({ password: 'auth.validation.passwordNeedsMix' })
  })

  it('reports each rule for the live checklist', () => {
    expect(passwordChecks('')).toEqual({ length: false, letter: false, digit: false })
    expect(passwordChecks('abc')).toEqual({ length: false, letter: true, digit: false })
    expect(passwordChecks('abcdefgh')).toEqual({ length: true, letter: true, digit: false })
    expect(passwordChecks('Z9')).toEqual({ length: false, letter: true, digit: true })
    expect(passwordChecks('كلمة١٢٣٤٥٦')).toEqual({ length: true, letter: false, digit: false })
  })
})

describe('formMessage', () => {
  it('adds the values a message needs and falls back for unknown text', () => {
    expect(formMessage('auth.validation.passwordTooShort')).toEqual({
      key: 'auth.validation.passwordTooShort',
      values: { count: AUTH_PASSWORD_MIN_LENGTH },
    })
    expect(formMessage('auth.validation.emailInvalid')).toEqual({
      key: 'auth.validation.emailInvalid',
    })
    expect(formMessage('Invalid input')).toEqual({ key: 'errors.validation' })
    expect(formMessage(undefined)).toBeUndefined()
  })
})

describe('codes', () => {
  it('keep digits only, Arabic-Indic digits included, cut to the code length', () => {
    expect(normalizeCode('٠١٢٣٤٥٦٧')).toBe('012345')
    expect(normalizeCode('Your code: 98 76 54')).toBe('987654')
    expect(isCompleteCode('123456')).toBe(true)
    expect(isCompleteCode('12345')).toBe(false)
  })

  it('count whole seconds down to zero', () => {
    expect(secondsUntil(61_000, 1_000)).toBe(60)
    expect(secondsUntil(61_000, 1_001)).toBe(60)
    expect(secondsUntil(61_000, 60_001)).toBe(1)
    expect(secondsUntil(61_000, 61_000)).toBe(0)
    expect(secondsUntil(61_000, 90_000)).toBe(0)
  })
})

describe('auth limits', () => {
  // The constants in @bizcost/contracts must match what the local Auth server enforces.
  const config = readFileSync(new URL('../../../../supabase/config.toml', import.meta.url), 'utf8')
  const setting = (section: string, key: string) => {
    const body = config.split(/^\[/m).find((s) => s.startsWith(`${section}]`)) ?? ''
    return new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, 'm').exec(body)?.[1]
  }

  it('match supabase/config.toml', () => {
    expect(setting('auth.email', 'otp_length')).toBe(String(AUTH_OTP_LENGTH))
    expect(setting('auth.email', 'max_frequency')).toBe(`${AUTH_RESEND_COOLDOWN_SECONDS}s`)
    expect(setting('auth', 'minimum_password_length')).toBe(String(AUTH_PASSWORD_MIN_LENGTH))
    // An ASCII letter and an ASCII digit: what newPasswordSchema and passwordChecks require.
    expect(setting('auth', 'password_requirements')).toBe('letters_digits')
  })
})
