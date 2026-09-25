import { describe, expect, it } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock } from '../test/fake-auth'
import {
  codeVerificationReducer,
  createCodeVerification,
  type CodeVerificationState,
} from './verify-flow'

const base: CodeVerificationState = {
  purpose: 'signIn',
  email: 'a@b.co',
  status: 'idle',
  error: null,
  notice: null,
  resendAvailableAt: 0,
}

describe('codeVerificationReducer', () => {
  it('ignores a second verify or resend while one is running', () => {
    const verifying = codeVerificationReducer(base, { type: 'verify' })
    expect(verifying.status).toBe('verifying')
    expect(codeVerificationReducer(verifying, { type: 'verify' })).toBe(verifying)
    expect(codeVerificationReducer(verifying, { type: 'resend' })).toBe(verifying)
  })

  it('clears the error and the notice when a new action starts', () => {
    const failed = { ...base, error: 'auth.errors.codeInvalid' as const, notice: 'resent' as const }
    expect(codeVerificationReducer(failed, { type: 'verify' })).toMatchObject({
      error: null,
      notice: null,
    })
  })

  it('starts a new cooldown after a resend', () => {
    const resending = codeVerificationReducer(base, { type: 'resend' })
    expect(codeVerificationReducer(resending, { type: 'resent', at: 5_000 })).toMatchObject({
      status: 'idle',
      notice: 'resent',
      resendAvailableAt: 65_000,
    })
  })

  it('stays verified', () => {
    const verified = { ...base, status: 'verified' as const }
    expect(codeVerificationReducer(verified, { type: 'failed', error: 'errors.internal' })).toBe(
      verified,
    )
    expect(codeVerificationReducer(verified, { type: 'verify' })).toBe(verified)
  })
})

describe('createCodeVerification', () => {
  it('verifies a sign-up code with type "email", normalizing Arabic digits', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createCodeVerification({ auth, email: 'A@b.co', purpose: 'signUp', locale: 'ar' })
    expect(await flow.verify('١٢٣ ٤٥٦')).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '123456',
      type: 'email',
    })
    expect(flow.getState().status).toBe('verified')
  })

  it('rejects an incomplete code without calling Supabase', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createCodeVerification({ auth, email: 'a@b.co', purpose: 'signIn', locale: 'ar' })
    expect(await flow.verify('12 3')).toBe(false)
    expect(flow.getState().error).toBe('auth.validation.codeIncomplete')
    expect(calls.verifyOtp).not.toHaveBeenCalled()
  })

  it('shows a wrong or expired code', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    const flow = createCodeVerification({ auth, email: 'a@b.co', purpose: 'signIn', locale: 'ar' })
    expect(await flow.verify('000000')).toBe(false)
    expect(flow.getState()).toMatchObject({ status: 'idle', error: 'auth.errors.codeInvalid' })
  })

  it('notifies subscribers of every change', async () => {
    const { auth } = fakeAuth()
    const flow = createCodeVerification({ auth, email: 'a@b.co', purpose: 'signIn', locale: 'ar' })
    const seen: string[] = []
    const unsubscribe = flow.subscribe(() => seen.push(flow.getState().status))
    await flow.verify('123456')
    unsubscribe()
    expect(seen).toEqual(['verifying', 'verified'])
  })

  it('waits 60 seconds before a resend', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const flow = createCodeVerification({
      auth,
      email: 'a@b.co',
      purpose: 'signUp',
      locale: 'en',
      ...clock,
    })
    await flow.resend()
    expect(calls.resend).not.toHaveBeenCalled()
    clock.advance(60_000)
    await flow.resend()
    expect(calls.resend).toHaveBeenCalledWith({ type: 'signup', email: 'a@b.co' })
    expect(flow.getState()).toMatchObject({
      notice: 'resent',
      resendAvailableAt: clock.now() + 60_000,
    })
  })

  it('resends a sign-in code the same way for any address (a missing account is created)', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'signInWithOtp', apiError('otp_disabled', 422))
    const flow = createCodeVerification({
      auth,
      email: 'nobody@b.co',
      purpose: 'signIn',
      locale: 'en',
      now: clock.now,
      sentAt: clock.now() - 60_000,
    })
    await flow.resend()
    expect(calls.signInWithOtp).toHaveBeenCalledWith({
      email: 'nobody@b.co',
      options: { shouldCreateUser: true, data: { locale: 'en' } },
    })
    expect(flow.getState()).toMatchObject({ status: 'idle', notice: 'resent', error: null })
  })
})
