import { hasMessage, LOCALES } from '@bizcost/i18n'
import {
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { apiError } from '../test/fake-auth'
import {
  AUTH_ERROR_KEYS,
  authErrorKey,
  isPasswordMessage,
  isSilentError,
  passwordErrorField,
  SILENT_ERROR_CODES,
} from './errors'

describe('authErrorKey', () => {
  it('maps Supabase error codes to i18n keys', () => {
    expect(authErrorKey(apiError('invalid_credentials'))).toBe('auth.errors.invalidCredentials')
    expect(authErrorKey(apiError('otp_expired', 403))).toBe('auth.errors.codeInvalid')
    expect(authErrorKey(apiError('same_password', 422))).toBe('auth.errors.samePassword')
    expect(authErrorKey(apiError('over_request_rate_limit', 429))).toBe('errors.rate_limited')
    expect(authErrorKey(apiError('session_not_found', 403))).toBe('errors.unauthorized')
  })

  it('never reads the message text', () => {
    const error = apiError('invalid_credentials')
    error.message = 'Signups not allowed for otp'
    expect(authErrorKey(error)).toBe('auth.errors.invalidCredentials')
  })

  it('maps weak_password reasons to the password rule messages', () => {
    type Reasons = ConstructorParameters<typeof AuthWeakPasswordError>[2]
    const weak = (reasons: Reasons) => authErrorKey(new AuthWeakPasswordError('weak', 422, reasons))
    expect(weak(['length'])).toBe('auth.validation.passwordTooShort')
    expect(weak(['characters'])).toBe('auth.validation.passwordNeedsMix')
    expect(weak(['length', 'characters'])).toBe('auth.validation.passwordTooShort')
    expect(weak(['pwned'])).toBe('auth.errors.passwordLeaked')
    expect(weak([])).toBe('auth.errors.weakPassword')
    // As the server sends it (`weak_password.reasons`, read by supabase-js), and without reasons.
    const fromServer = Object.assign(apiError('weak_password', 422), { reasons: ['characters'] })
    expect(authErrorKey(fromServer)).toBe('auth.validation.passwordNeedsMix')
    const unknown = Object.assign(apiError('weak_password', 422), { reasons: ['something_new'] })
    expect(authErrorKey(unknown)).toBe('auth.errors.weakPassword')
    expect(authErrorKey(apiError('weak_password', 422))).toBe('auth.errors.weakPassword')
  })

  it('puts password messages under the password field', () => {
    for (const key of [
      'auth.validation.passwordTooShort',
      'auth.validation.passwordNeedsMix',
      'auth.validation.passwordTooLong',
      'auth.errors.weakPassword',
      'auth.errors.passwordLeaked',
      'auth.errors.samePassword',
    ] as const) {
      expect(isPasswordMessage(key), key).toBe(true)
      expect(passwordErrorField(key, 'password'), key).toBe('password')
    }
    expect(isPasswordMessage('errors.validation')).toBe(false)
    expect(passwordErrorField('errors.validation', 'password')).toBe('password')
    expect(isPasswordMessage('auth.errors.codeInvalid')).toBe(false)
    expect(passwordErrorField('auth.errors.codeInvalid', 'password')).toBeUndefined()
  })

  it('maps network, missing-session and unknown errors', () => {
    expect(authErrorKey(new AuthRetryableFetchError('fetch failed', 0))).toBe('errors.network')
    expect(authErrorKey(new AuthSessionMissingError())).toBe('errors.unauthorized')
    expect(authErrorKey(apiError('something_new', 429))).toBe('errors.rate_limited')
    expect(authErrorKey(apiError('something_new', 500))).toBe('errors.internal')
    expect(authErrorKey(new Error('boom'))).toBe('errors.internal')
    expect(authErrorKey('boom')).toBe('errors.internal')
    expect(authErrorKey(null)).toBe('errors.internal')
    expect(authErrorKey(apiError('toString'))).toBe('errors.internal')
  })

  it('only uses keys that exist in English and Arabic', () => {
    const keys = [
      ...Object.values(AUTH_ERROR_KEYS),
      'auth.errors.passwordLeaked',
      'auth.validation.passwordTooShort',
      'auth.validation.passwordNeedsMix',
      'errors.network',
      'errors.internal',
    ]
    for (const locale of LOCALES) {
      for (const key of keys) expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
    }
  })
})

describe('isSilentError', () => {
  it('hides "no such account" answers of the code requests', () => {
    expect(isSilentError(apiError('otp_disabled', 422), 'signInCode')).toBe(true)
    expect(isSilentError(apiError('user_already_exists', 422), 'signUp')).toBe(true)
    expect(isSilentError(apiError('email_exists', 422), 'emailChange')).toBe(true)
    expect(isSilentError(apiError('invalid_credentials'), 'signInCode')).toBe(false)
    expect(isSilentError(new Error('x'), 'signUp')).toBe(false)
  })

  it('never hides a wrong code or a wrong password', () => {
    for (const codes of Object.values(SILENT_ERROR_CODES)) {
      expect(codes).not.toContain('otp_expired')
      expect(codes).not.toContain('invalid_credentials')
    }
  })
})
