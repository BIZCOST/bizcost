import { describe, expect, it } from 'vitest'
import {
  apiError,
  failOnce,
  FAKE_USER,
  fakeAccessToken,
  fakeAuth,
  fakeClock,
  fakeSession,
  sessionOnce,
  type FakeAuth,
} from '../test/fake-auth'
import {
  codeConfirmedAddress,
  createPasswordReset,
  passwordResetReducer,
  sessionIdOf,
  type PasswordResetOptions,
  type PasswordResetState,
} from './reset-flow'

const PASSWORD = 'a-new-password-1'

/** A reset whose code was accepted (step 'choose'). */
async function verified(calls?: (c: FakeAuth) => void) {
  const fake = fakeAuth()
  calls?.(fake.calls)
  const flow = createPasswordReset({ auth: fake.auth, email: 'a@b.co' })
  expect(await flow.verify('123456')).toBe(true)
  return { flow, calls: fake.calls }
}

/** The account was never confirmed: this recovery code is what confirmed the address. */
const PRE_REGISTERED = {
  ...FAKE_USER,
  recovery_sent_at: '2026-09-25T09:52:03.206000Z',
  email_confirmed_at: '2026-09-25T09:52:07.263000Z',
}

describe('createPasswordReset', () => {
  it('asks only for the code, which signs the user in, then offers the choice', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordReset({ auth, email: 'A@b.co' })
    expect(flow.getState()).toMatchObject({ step: 'code', email: 'a@b.co' })
    expect(await flow.verify('١٢٣ ٤٥٦')).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '123456',
      type: 'recovery',
    })
    expect(flow.getState()).toMatchObject({
      step: 'choose',
      status: 'idle',
      passwordRequired: false,
      error: null,
    })
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('goes straight in without touching the password or other sessions', async () => {
    const { flow, calls } = await verified()
    flow.skip()
    expect(flow.getState()).toMatchObject({ step: 'done', passwordChanged: false })
    expect(calls.updateUser).not.toHaveBeenCalled()
    expect(calls.signOut).not.toHaveBeenCalled()
  })

  it('saves a new password when the user chooses to change it', async () => {
    const { flow, calls } = await verified()
    expect(await flow.savePassword(PASSWORD)).toBe(false) // not before choosing
    flow.choosePassword()
    expect(flow.getState().step).toBe('password')
    expect(await flow.savePassword(PASSWORD)).toBe(true)
    expect(calls.updateUser).toHaveBeenCalledWith({ password: PASSWORD })
    expect(flow.getState()).toMatchObject({ step: 'done', passwordChanged: true, error: null })
  })

  it('can go back from the new password to the choice', async () => {
    const { flow } = await verified()
    flow.choosePassword()
    flow.back()
    expect(flow.getState().step).toBe('choose')
    flow.skip()
    expect(flow.getState()).toMatchObject({ step: 'done', passwordChanged: false })
  })

  it('never offers the choice for a wrong code', async () => {
    const { auth, calls } = fakeAuth()
    failOnce(calls, 'verifyOtp', apiError('otp_expired', 403))
    const flow = createPasswordReset({ auth, email: 'a@b.co' })
    expect(await flow.verify('000000')).toBe(false)
    expect(flow.getState()).toMatchObject({
      step: 'code',
      error: { key: 'auth.errors.codeInvalid', field: 'code' },
    })
    flow.choosePassword()
    flow.skip()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState().step).toBe('code')
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('keeps the password step open when only the password is rejected', async () => {
    const { flow, calls } = await verified((c) =>
      failOnce(c, 'updateUser', apiError('same_password', 422)),
    )
    flow.choosePassword()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState()).toMatchObject({
      step: 'password',
      error: { key: 'auth.errors.samePassword', field: 'password' },
    })
    expect(await flow.savePassword(`${PASSWORD}x`)).toBe(true)
    expect(calls.verifyOtp).toHaveBeenCalledTimes(1)
  })

  it('signs this device out instead of saving when the verified session is gone', async () => {
    const { flow, calls } = await verified()
    flow.choosePassword()
    sessionOnce(calls, null)
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState()).toMatchObject({ step: 'ended', status: 'idle' })
    expect(calls.updateUser).not.toHaveBeenCalled()
    expect(calls.signOut).toHaveBeenCalledWith({ scope: 'local' })
    flow.back()
    flow.skip()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState().step).toBe('ended')
  })

  it("never sets another account's password", async () => {
    const { flow, calls } = await verified()
    flow.choosePassword()
    sessionOnce(calls, { id: '00000000-0000-4000-8000-000000000002' })
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState().step).toBe('ended')
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('never saves when the code did not come with a session id', async () => {
    const { auth, calls } = fakeAuth()
    calls.verifyOtp.mockResolvedValueOnce({
      data: { user: FAKE_USER, session: { ...fakeSession(), access_token: 'not-a-token' } },
      error: null,
    })
    const flow = createPasswordReset({ auth, email: 'a@b.co' })
    expect(await flow.verify('123456')).toBe(true)
    flow.choosePassword()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState().step).toBe('ended')
    expect(calls.updateUser).not.toHaveBeenCalled()
  })

  it('ends when Supabase no longer accepts the session', async () => {
    const { flow } = await verified((c) =>
      failOnce(c, 'updateUser', apiError('session_not_found', 403)),
    )
    flow.choosePassword()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState()).toMatchObject({ step: 'ended', error: null })
  })

  it('shows a network problem while checking the session and lets the user retry', async () => {
    const { flow, calls } = await verified()
    flow.choosePassword()
    calls.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: Object.assign(new Error('offline'), { name: 'AuthRetryableFetchError' }),
    })
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState()).toMatchObject({ step: 'password', error: { key: 'errors.network' } })
    expect(await flow.savePassword(PASSWORD)).toBe(true)
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
    expect(await flow.verify('12')).toBe(false)
    expect(flow.getState().error).toEqual({ key: 'auth.validation.codeIncomplete', field: 'code' })
    expect(calls.verifyOtp).not.toHaveBeenCalled()
  })
})

describe('createPasswordReset: a code that confirmed the address', () => {
  async function preRegistered(options: Partial<PasswordResetOptions> = {}) {
    const { auth, calls } = fakeAuth()
    calls.verifyOtp.mockResolvedValueOnce({
      data: { user: PRE_REGISTERED, session: fakeSession(PRE_REGISTERED) },
      error: null,
    })
    const flow = createPasswordReset({ auth, email: 'a@b.co', ...options })
    expect(await flow.verify('123456')).toBe(true)
    return { flow, calls }
  }

  it('requires a new password: no choice, no skip, no way back', async () => {
    const { flow, calls } = await preRegistered()
    expect(flow.getState()).toMatchObject({ step: 'password', passwordRequired: true })
    flow.skip()
    flow.back()
    expect(flow.getState().step).toBe('password')
    expect(await flow.savePassword(PASSWORD)).toBe(true)
    expect(calls.updateUser).toHaveBeenCalledWith({ password: PASSWORD })
    expect(flow.getState()).toMatchObject({ step: 'done', passwordChanged: true })
  })

  it('keeps requiring it after a restart, when the next code looks like a normal account', async () => {
    const clock = fakeClock()
    const { flow, calls } = await preRegistered(clock)
    sessionOnce(calls, null)
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(flow.getState().step).toBe('ended')
    clock.advance(60_000)
    await flow.restart()
    expect(flow.getState()).toMatchObject({ step: 'code', passwordRequired: true })
    expect(await flow.verify('654321')).toBe(true) // FAKE_USER: confirmed long ago
    expect(flow.getState()).toMatchObject({ step: 'password', passwordRequired: true })
  })

  it('is required when Supabase leaves out the timestamps', () => {
    expect(codeConfirmedAddress(PRE_REGISTERED)).toBe(true)
    expect(codeConfirmedAddress(FAKE_USER)).toBe(false)
    expect(codeConfirmedAddress({ id: 'x' } as never)).toBe(true)
    expect(codeConfirmedAddress({ ...FAKE_USER, recovery_sent_at: null })).toBe(true)
    expect(codeConfirmedAddress({ ...FAKE_USER, email_confirmed_at: 'not a date' })).toBe(true)
    expect(codeConfirmedAddress(null)).toBe(true)
  })
})

describe('createPasswordReset: opened again after the code was used', () => {
  it('lets a device that is still signed in continue, without a password change', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordReset({ auth, email: 'a@b.co', codeUsed: true })
    expect(flow.getState()).toMatchObject({ step: 'resuming', status: 'idle' })
    flow.choosePassword()
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    const resuming = flow.resume()
    void flow.resume() // a second call while checking changes nothing
    await resuming
    expect(flow.getState()).toMatchObject({ step: 'signedIn', status: 'idle' })
    flow.choosePassword()
    expect(flow.getState().step).toBe('signedIn')
    flow.skip()
    expect(flow.getState()).toMatchObject({ step: 'done', passwordChanged: false })
    expect(calls.getSession).toHaveBeenCalledTimes(1)
    expect(calls.updateUser).not.toHaveBeenCalled()
    expect(calls.signOut).not.toHaveBeenCalled()
  })

  it('ends when this device is no longer signed in', async () => {
    const { auth, calls } = fakeAuth()
    sessionOnce(calls, null)
    const flow = createPasswordReset({ auth, email: 'a@b.co', codeUsed: true })
    await flow.resume()
    expect(flow.getState()).toMatchObject({ step: 'ended', status: 'idle' })
    expect(calls.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('signs out and asks for a new code when a new password was required', async () => {
    const { auth, calls } = fakeAuth()
    const flow = createPasswordReset({
      auth,
      email: 'a@b.co',
      codeUsed: true,
      passwordRequired: true,
    })
    await flow.resume()
    expect(flow.getState()).toMatchObject({ step: 'ended', passwordRequired: true })
    expect(calls.signOut).toHaveBeenCalledWith({ scope: 'local' })
    flow.skip()
    expect(flow.getState().step).toBe('ended')
  })

  it('restarts with a new code, or with the countdown while the last code is recent', async () => {
    const clock = fakeClock()
    const { auth, calls } = fakeAuth()
    sessionOnce(calls, null)
    const flow = createPasswordReset({ auth, email: 'a@b.co', codeUsed: true, ...clock })
    await flow.resume()
    await flow.restart()
    expect(flow.getState()).toMatchObject({ step: 'code', status: 'idle', notice: null })
    expect(calls.resetPasswordForEmail).not.toHaveBeenCalled()
    clock.advance(60_000)
    await flow.resend()
    expect(calls.resetPasswordForEmail).toHaveBeenCalledWith('a@b.co')
    expect(await flow.verify('123456')).toBe(true)
    expect(flow.getState().step).toBe('choose')
  })
})

describe('sessionIdOf', () => {
  it('reads the session id claim, and nothing from a malformed token', () => {
    expect(sessionIdOf(fakeAccessToken({ session_id: 'abc', name: 'راشد' }))).toBe('abc')
    for (const token of [
      undefined,
      '',
      'a.b.c',
      'onlyonepart',
      fakeAccessToken({}),
      fakeAccessToken({ session_id: 7 }),
      fakeAccessToken({ session_id: '' }),
    ]) {
      expect(sessionIdOf(token)).toBeNull()
    }
  })
})

describe('passwordResetReducer', () => {
  const base: PasswordResetState = {
    email: 'a@b.co',
    step: 'code',
    status: 'idle',
    passwordRequired: false,
    passwordChanged: false,
    error: null,
    notice: null,
    resendAvailableAt: 0,
  }

  it('ignores a second submit and the later steps before the code', () => {
    const verifying = passwordResetReducer(base, { type: 'verify' })
    expect(passwordResetReducer(verifying, { type: 'verify' })).toBe(verifying)
    expect(passwordResetReducer(verifying, { type: 'resend' })).toBe(verifying)
    for (const type of [
      'choosePassword',
      'skip',
      'save',
      'sessionEnded',
      'resume',
      'resumed',
      'restart',
    ] as const) {
      expect(passwordResetReducer(base, { type })).toBe(base)
    }
  })

  it('keeps a finished or ended reset as it is', () => {
    const done = { ...base, step: 'done' as const, passwordChanged: true }
    const ended = { ...base, step: 'ended' as const }
    for (const state of [done, ended]) {
      expect(
        passwordResetReducer(state, { type: 'failed', error: { key: 'errors.internal' } }),
      ).toBe(state)
      expect(passwordResetReducer(state, { type: 'sessionEnded' })).toBe(state)
      expect(passwordResetReducer(state, { type: 'skip' })).toBe(state)
    }
  })
})
