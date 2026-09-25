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
  codeFormSchema,
  emailCodesSchema,
  formMessage,
  profileFormSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from './forms'

function messages(schema: z.ZodMiniType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value)
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))
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

  it('limit new passwords to 72 UTF-8 bytes (bcrypt)', () => {
    const ok = { email: 'a@b.co', password: 'a'.repeat(72) }
    expect(signUpSchema.safeParse(ok).success).toBe(true)
    expect(messages(signUpSchema, { ...ok, password: 'ب'.repeat(37) })).toEqual({
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
    const value = { code: '123456', password: 'long-enough-1', confirmPassword: 'long-enough-2' }
    expect(messages(resetPasswordSchema, value)).toEqual({
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
  })
})
