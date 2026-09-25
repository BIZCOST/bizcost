import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, failOnce, fakeAuth, tooSoon } from '../test/fake-auth'
import {
  requestPasswordReset,
  requestSignInCode,
  signInWithPassword,
  signOut,
  signUp,
  syncAuthLocale,
} from './commands'
import { AuthRetryableFetchError, AuthWeakPasswordError } from '@supabase/supabase-js'

describe('signUp', () => {
  it('sends the locale as user metadata and normalizes the email', async () => {
    const { auth, calls } = fakeAuth()
    const result = await signUp(auth, {
      email: '  Sara@Example.COM ',
      password: 'long-enough-1',
      locale: 'ar',
    })
    expect(result).toEqual({ ok: true, email: 'sara@example.com' })
    expect(calls.signUp).toHaveBeenCalledWith({
      email: 'sara@example.com',
      password: 'long-enough-1',
      options: { data: { locale: 'ar' } },
    })
  })

  it('answers an existing address exactly like a new one', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signUp', apiError('user_already_exists', 422))
    const existing = await signUp(auth, { email: 'a@b.co', password: 'abcdef12', locale: 'en' })
    const fresh = await signUp(auth, { email: 'a@b.co', password: 'abcdef12', locale: 'en' })
    expect(existing).toEqual(fresh)
  })

  it('shows real problems', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signUp', apiError('weak_password', 422))
    expect(await signUp(auth, { email: 'a@b.co', password: 'x', locale: 'en' })).toEqual({
      ok: false,
      error: 'auth.errors.weakPassword',
    })
  })

  it("shows the Auth server's password rule as the matching field message", async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signUp', new AuthWeakPasswordError('weak', 422, ['characters']))
    expect(await signUp(auth, { email: 'a@b.co', password: 'abcdefgh', locale: 'en' })).toEqual({
      ok: false,
      error: 'auth.validation.passwordNeedsMix',
    })
  })

  it('says when no email can be sent right now instead of pretending one was sent', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signUp', apiError('over_email_send_rate_limit', 429))
    expect(await signUp(auth, { email: 'a@b.co', password: 'abcdef12', locale: 'en' })).toEqual({
      ok: false,
      error: 'auth.errors.emailRateLimited',
    })
  })
})

describe('signInWithPassword', () => {
  it('signs in', async () => {
    const { auth } = fakeAuth()
    expect(await signInWithPassword(auth, { email: 'a@b.co', password: 'pw' })).toEqual({
      ok: true,
      next: 'signedIn',
    })
  })

  it('says only "email or password is wrong" for a wrong password or an unknown email', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signInWithPassword', apiError('invalid_credentials'))
    expect(await signInWithPassword(auth, { email: 'a@b.co', password: 'pw' })).toEqual({
      ok: false,
      error: 'auth.errors.invalidCredentials',
    })
  })

  it('sends a new sign-up code when the email is not confirmed yet', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signInWithPassword', apiError('email_not_confirmed'))
    expect(await signInWithPassword(auth, { email: 'A@b.co', password: 'pw' })).toEqual({
      ok: true,
      next: 'confirmEmail',
      email: 'a@b.co',
    })
    expect(calls.resend).toHaveBeenCalledWith({ type: 'signup', email: 'a@b.co' })
  })
})

describe('requestSignInCode', () => {
  it('asks for a code for any address, creating a missing account in the page language', async () => {
    const { auth, calls } = fakeAuth()
    await requestSignInCode(auth, { email: ' A@b.co', locale: 'ar' })
    expect(calls.signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      options: { shouldCreateUser: true, data: { locale: 'ar' } },
    })
  })

  it('treats "Signups not allowed for otp" (sign-ups closed) exactly like success', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signInWithOtp', apiError('otp_disabled', 422))
    const unknown = await requestSignInCode(auth, { email: 'nobody@b.co', locale: 'en' })
    const known = await requestSignInCode(auth, { email: 'nobody@b.co', locale: 'en' })
    expect(unknown).toEqual({ ok: true, email: 'nobody@b.co' })
    expect(unknown).toEqual(known)
  })

  it('reports a network failure', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signInWithOtp', new AuthRetryableFetchError('fetch failed', 0))
    expect(await requestSignInCode(auth, { email: 'a@b.co', locale: 'en' })).toEqual({
      ok: false,
      error: 'errors.network',
    })
  })
})

describe('requestPasswordReset', () => {
  it('answers the same for any address', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'resetPasswordForEmail', apiError('user_not_found', 404))
    expect(await requestPasswordReset(auth, { email: 'x@b.co' })).toEqual({
      ok: true,
      email: 'x@b.co',
    })
    expect(calls.resetPasswordForEmail).toHaveBeenCalledWith('x@b.co')
  })
})

describe('signOut and syncAuthLocale', () => {
  it('signs out here or everywhere; a session already gone counts as signed out', async () => {
    const { auth, calls } = fakeAuth()
    expect(await signOut(auth, 'global')).toEqual({ ok: true })
    expect(calls.signOut).toHaveBeenCalledWith({ scope: 'global' })
    failOnce(calls, 'signOut', apiError('session_not_found', 404))
    expect(await signOut(auth, 'local')).toEqual({ ok: true })
    expect(calls.signOut).toHaveBeenLastCalledWith({ scope: 'local' })
  })

  it('saves the language in user metadata for the auth emails', async () => {
    const { auth, calls } = fakeAuth()
    expect(await syncAuthLocale(auth, 'en')).toEqual({ ok: true })
    expect(calls.updateUser).toHaveBeenCalledWith({ data: { locale: 'en' } })
  })
})

describe('a code request answered "too soon" (D-073)', () => {
  const T = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })
  afterEach(() => vi.useRealTimers())

  it('looks sent, and says when the code screen sends it again', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'resetPasswordForEmail', tooSoon(34))
    expect(await requestPasswordReset(auth, { email: 'a@b.co' })).toEqual({
      ok: true,
      email: 'a@b.co',
      retryAt: T + 35_000,
    })
    failOnce(calls, 'signInWithOtp', tooSoon())
    expect(await requestSignInCode(auth, { email: 'a@b.co', locale: 'en' })).toEqual({
      ok: true,
      email: 'a@b.co',
      retryAt: T + 61_000,
    })
    failOnce(calls, 'signInWithPassword', apiError('email_not_confirmed'))
    failOnce(calls, 'resend', tooSoon(57))
    expect(await signInWithPassword(auth, { email: 'a@b.co', password: 'pw' })).toEqual({
      ok: true,
      next: 'confirmEmail',
      email: 'a@b.co',
      retryAt: T + 58_000,
    })
  })

  it('plans no retry for any other answer', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'resetPasswordForEmail', apiError('user_not_found', 404))
    expect(await requestPasswordReset(auth, { email: 'a@b.co' })).toEqual({
      ok: true,
      email: 'a@b.co',
    })
    expect(await requestSignInCode(auth, { email: 'a@b.co', locale: 'en' })).toEqual({
      ok: true,
      email: 'a@b.co',
    })
  })
})

describe('asked again for the code this tab just sent (D-073)', () => {
  const T = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })
  afterEach(() => vi.useRealTimers())
  /** The same request, sent to the same address 4 s ago (it went out; no retry planned). */
  const sent = { email: 'A@b.co', sentAt: T - 4_000 }

  it('plans no retry: that code still works, and a second email would replace it', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'resetPasswordForEmail', tooSoon(55))
    expect(await requestPasswordReset(auth, { email: 'a@b.co', sent })).toEqual({
      ok: true,
      email: 'a@b.co',
    })
    failOnce(calls, 'signInWithOtp', tooSoon(55))
    expect(await requestSignInCode(auth, { email: 'a@b.co', locale: 'en', sent })).toEqual({
      ok: true,
      email: 'a@b.co',
    })
    failOnce(calls, 'signInWithPassword', apiError('email_not_confirmed'))
    failOnce(calls, 'resend', tooSoon(55))
    expect(await signInWithPassword(auth, { email: 'a@b.co', password: 'pw', sent })).toEqual({
      ok: true,
      next: 'confirmEmail',
      email: 'a@b.co',
    })
  })

  it('still retries when that code went to another address or a cooldown ago', async () => {
    const { auth, calls } = fakeAuth()
    for (const earlier of [
      { email: 'other@b.co', sentAt: T - 4_000 },
      { email: 'a@b.co', sentAt: T - 60_000 },
    ]) {
      failOnce(calls, 'resetPasswordForEmail', tooSoon(34))
      expect(await requestPasswordReset(auth, { email: 'a@b.co', sent: earlier })).toEqual({
        ok: true,
        email: 'a@b.co',
        retryAt: T + 35_000,
      })
    }
  })

  it('a second sign-up of a new address looks like the first; any other rate limit is shown', async () => {
    const { auth, calls } = fakeAuth()
    const input = { email: 'a@b.co', password: 'abcdef12', locale: 'en' } as const
    failOnce(calls, 'signUp', tooSoon(55))
    expect(await signUp(auth, { ...input, sent })).toEqual({ ok: true, email: 'a@b.co' })
    // The same as a registered address signing up twice (a silent no-op).
    expect(await signUp(auth, { ...input, sent })).toEqual({ ok: true, email: 'a@b.co' })
    failOnce(calls, 'signUp', tooSoon(55))
    expect(await signUp(auth, { ...input, sent: { ...sent, email: 'other@b.co' } })).toEqual({
      ok: false,
      error: 'auth.errors.emailRateLimited',
    })
    failOnce(calls, 'signUp', tooSoon())
    expect(await signUp(auth, input)).toEqual({ ok: false, error: 'auth.errors.emailRateLimited' })
  })
})
