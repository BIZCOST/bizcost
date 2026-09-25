import { hasMessage, LOCALES } from '@bizcost/i18n'
import {
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { apiError } from '../test/fake-auth'
import { AUTH_ERROR_KEYS, authErrorKey, isSilentError, SILENT_ERROR_CODES } from './errors'

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

  it('tells a leaked password from a weak one', () => {
    expect(authErrorKey(new AuthWeakPasswordError('weak', 422, ['length']))).toBe(
      'auth.errors.weakPassword',
    )
    expect(authErrorKey(new AuthWeakPasswordError('weak', 422, ['pwned']))).toBe(
      'auth.errors.passwordLeaked',
    )
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
