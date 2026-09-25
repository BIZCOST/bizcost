import { describe, expect, it } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock } from '../test/fake-auth'
import { createPasswordReset } from './reset-flow'

const PASSWORD = 'a-new-password-1'

describe('createPasswordReset', () => {
  it('verifies the recovery code, then saves the password', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordReset({ auth, email: 'A@b.co' })
    expect(await flow.submit({ code: '123456', password: PASSWORD })).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '123456',
      type: 'recovery',
    })
    expect(calls.updateUser).toHaveBeenCalledWith({ password: PASSWORD })
    expect(flow.getState()).toMatchObject({ status: 'done', codeVerified: true, error: null })
  })

  it('puts a wrong code under the code field and keeps the password', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    const flow = createPasswordReset({ auth, email: 'a@b.co' })
    expect(await flow.submit({ code: '000000', password: PASSWORD })).toBe(false)
    expect(flow.getState().error).toEqual({ key: 'auth.errors.codeInvalid', field: 'code' })
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('does not verify the used code again when only the password was rejected', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'updateUser', apiError('same_password', 422))
    const flow = createPasswordReset({ auth, email: 'a@b.co' })
    expect(await flow.submit({ code: '123456', password: PASSWORD })).toBe(false)
    expect(flow.getState()).toMatchObject({
      codeVerified: true,
      error: { key: 'auth.errors.samePassword', field: 'password' },
    })
    expect(await flow.submit({ code: '', password: `${PASSWORD}x` })).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledTimes(1)
  })

  it('resends a recovery code after the cooldown, the same way for any address', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'resetPasswordForEmail', apiError('user_not_found', 404))
    const flow = createPasswordReset({ auth, email: 'a@b.co', ...clock })
    await flow.resend()
    expect(calls.resetPasswordForEmail).not.toHaveBeenCalled()
    clock.advance(60_000)
    await flow.resend()
    expect(calls.resetPasswordForEmail).toHaveBeenCalledWith('a@b.co')
    expect(flow.getState()).toMatchObject({ notice: 'resent', error: null })
  })

  it('rejects an incomplete code before calling Supabase', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordReset({ auth, email: 'a@b.co' })
    expect(await flow.submit({ code: '12', password: PASSWORD })).toBe(false)
    expect(flow.getState().error).toEqual({ key: 'auth.validation.codeIncomplete', field: 'code' })
    expect(calls.verifyOtp).not.toHaveBeenCalled()
  })
})
