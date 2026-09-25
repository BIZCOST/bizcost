import { describe, expect, it } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock } from '../test/fake-auth'
import { createEmailChange } from './email-flow'

describe('createEmailChange', () => {
  it('verifies the current address code and the new address code, each with its address', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createEmailChange({ auth, currentEmail: 'Old@b.co' })
    await flow.sendCodes(' New@B.co ')
    expect(calls.updateUser).toHaveBeenCalledWith({ email: 'new@b.co' })
    expect(flow.getState()).toMatchObject({ step: 'codes', newEmail: 'new@b.co' })

    expect(await flow.submit({ currentCode: '111111', newCode: '222222' })).toBe(true)
    expect(calls.verifyOtp.mock.calls).toEqual([
      [{ email: 'old@b.co', token: '111111', type: 'email_change' }],
      [{ email: 'new@b.co', token: '222222', type: 'email_change' }],
    ])
    expect(flow.getState()).toMatchObject({ step: 'done', currentEmail: 'new@b.co' })
  })

  it('sends only the code not yet accepted on a retry', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createEmailChange({ auth, currentEmail: 'old@b.co' })
    await flow.sendCodes('new@b.co')
    calls.verifyOtp
      .mockResolvedValueOnce({ data: { user: null, session: null }, error: null })
      .mockResolvedValueOnce({
        data: { user: null, session: null },
        error: apiError('otp_expired', 403),
      })
    expect(await flow.submit({ currentCode: '111111', newCode: '000000' })).toBe(false)
    expect(flow.getState()).toMatchObject({
      currentCodeVerified: true,
      newCodeVerified: false,
      error: { key: 'auth.errors.codeInvalid', field: 'newCode' },
    })
    expect(await flow.submit({ currentCode: '', newCode: '222222' })).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledTimes(3)
    expect(calls.verifyOtp).toHaveBeenLastCalledWith({
      email: 'new@b.co',
      token: '222222',
      type: 'email_change',
    })
  })

  it('answers an address another account uses exactly like a free one', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'updateUser', apiError('email_exists', 422))
    const flow = createEmailChange({ auth, currentEmail: 'old@b.co' })
    await flow.sendCodes('taken@b.co')
    expect(flow.getState()).toMatchObject({ step: 'codes', error: null })
  })

  it('refuses the current address and an empty one without calling Supabase', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createEmailChange({ auth, currentEmail: 'old@b.co' })
    await flow.sendCodes('OLD@b.co')
    expect(flow.getState().error).toEqual({ key: 'account.email.sameEmail', field: 'newEmail' })
    await flow.sendCodes('  ')
    expect(flow.getState().error).toEqual({
      key: 'auth.validation.emailRequired',
      field: 'newEmail',
    })
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('sends new codes after the cooldown and needs both codes again', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    const flow = createEmailChange({ auth, currentEmail: 'old@b.co', ...clock })
    await flow.sendCodes('new@b.co')
    failOnce(calls, 'verifyOtp', null)
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    await flow.submit({ currentCode: '111111', newCode: '000000' })
    await flow.sendCodes()
    expect(calls.updateUser).toHaveBeenCalledTimes(1)
    clock.advance(60_000)
    await flow.sendCodes()
    expect(calls.updateUser).toHaveBeenLastCalledWith({ email: 'new@b.co' })
    expect(flow.getState()).toMatchObject({
      notice: 'resent',
      currentCodeVerified: false,
      newCodeVerified: false,
    })
  })

  it('shows a rate limit when asking for codes too often', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'updateUser', apiError('over_email_send_rate_limit', 429))
    const flow = createEmailChange({ auth, currentEmail: 'old@b.co' })
    await flow.sendCodes('new@b.co')
    expect(flow.getState()).toMatchObject({
      step: 'start',
      error: { key: 'auth.errors.emailRateLimited' },
    })
    flow.cancel()
    expect(flow.getState()).toMatchObject({ step: 'start', newEmail: null, error: null })
  })
})
