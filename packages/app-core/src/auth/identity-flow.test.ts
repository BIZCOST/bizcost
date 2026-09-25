import { describe, expect, it } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock } from '../test/fake-auth'
import { createIdentityCheck } from './identity-flow'

describe('createIdentityCheck', () => {
  it('emails a code to the signed-in user and confirms it with Supabase Auth', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const check = createIdentityCheck({ auth, email: ' Owner@Example.com ', ...clock })
    await check.sendCode()
    expect(calls.signInWithOtp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      options: { shouldCreateUser: false },
    })
    expect(check.getState()).toMatchObject({
      step: 'code',
      resendAvailableAt: clock.now() + 60_000,
    })
    expect(await check.confirm('12 34 ٥٦')).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      token: '123456',
      type: 'email',
    })
    expect(check.getState().step).toBe('confirmed')
  })

  it('keeps asking for the code when it is wrong or incomplete', async () => {
    const { auth, calls } = fakeAuth()
    const check = createIdentityCheck({ auth, email: 'a@b.co' })
    expect(await check.confirm('123456')).toBe(false)
    expect(calls.verifyOtp).not.toHaveBeenCalled()
    await check.sendCode()
    expect(await check.confirm('123')).toBe(false)
    expect(check.getState().error).toBe('auth.validation.codeIncomplete')
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    expect(await check.confirm('000000')).toBe(false)
    expect(check.getState()).toMatchObject({ step: 'code', error: 'auth.errors.codeInvalid' })
  })

  it('resends after the cooldown and starts over on reset', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const check = createIdentityCheck({ auth, email: 'a@b.co', ...clock })
    await check.sendCode()
    await check.sendCode()
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    clock.advance(60_000)
    await check.sendCode()
    expect(check.getState().notice).toBe('resent')
    check.reset()
    expect(check.getState()).toMatchObject({ step: 'start', error: null, notice: null })
  })

  it('shows why a code could not be sent', async () => {
    const { auth, calls } = fakeAuth()
    const check = createIdentityCheck({ auth, email: 'a@b.co' })
    failOnce(calls, 'signInWithOtp', apiError('over_email_send_rate_limit', 429))
    await check.sendCode()
    expect(check.getState()).toMatchObject({
      step: 'start',
      error: 'auth.errors.emailRateLimited',
    })
  })
})
