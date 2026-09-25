import { describe, expect, it } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock } from '../test/fake-auth'
import { createPasswordChange } from './password-flow'

const PASSWORD = 'a-new-password-1'
const EMAIL = 'Sara@Example.com'

describe('createPasswordChange', () => {
  it('emails a code, has Supabase Auth check it, then saves the password', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const flow = createPasswordChange({ auth, email: EMAIL, ...clock })
    await flow.sendCode()
    expect(calls.signInWithOtp).toHaveBeenCalledWith({
      email: 'sara@example.com',
      options: { shouldCreateUser: false },
    })
    expect(flow.getState()).toMatchObject({ step: 'code', resendAvailableAt: clock.now() + 60_000 })
    expect(await flow.submit({ code: '٤٥٦٧٨٩', password: PASSWORD })).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledWith({
      email: 'sara@example.com',
      token: '456789',
      type: 'email',
    })
    expect(calls.updateUser).toHaveBeenCalledWith({ password: PASSWORD })
    expect(flow.getState().step).toBe('done')
  })

  it('never saves the password when the server refuses the code', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordChange({ auth, email: EMAIL })
    await flow.sendCode()
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    expect(await flow.submit({ code: '000000', password: PASSWORD })).toBe(false)
    expect(flow.getState().error).toEqual({ key: 'auth.errors.codeInvalid', field: 'code' })
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('puts password problems under the password and does not check the used code again', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordChange({ auth, email: EMAIL })
    await flow.sendCode()
    failOnce(calls, 'updateUser', apiError('weak_password', 422))
    await flow.submit({ code: '111111', password: PASSWORD })
    expect(flow.getState()).toMatchObject({
      step: 'code',
      codeVerified: true,
      error: { key: 'auth.errors.weakPassword', field: 'password' },
    })
    expect(await flow.submit({ code: '', password: `${PASSWORD}-2` })).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledTimes(1)
  })

  it('resends the code only after the cooldown', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const flow = createPasswordChange({ auth, email: EMAIL, ...clock })
    await flow.sendCode()
    await flow.sendCode()
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    clock.advance(60_000)
    await flow.sendCode()
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(2)
    expect(flow.getState().notice).toBe('resent')
  })

  it('does nothing before a code was sent, and starts over on cancel', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordChange({ auth, email: EMAIL })
    expect(await flow.submit({ code: '123456', password: PASSWORD })).toBe(false)
    expect(calls.updateUser).not.toHaveBeenCalled()
    failOnce(calls, 'signInWithOtp', apiError('over_email_send_rate_limit', 429))
    await flow.sendCode()
    expect(flow.getState()).toMatchObject({
      step: 'start',
      error: { key: 'auth.errors.emailRateLimited' },
    })
    await flow.sendCode()
    flow.cancel()
    expect(flow.getState()).toMatchObject({ step: 'start', error: null })
  })
})
