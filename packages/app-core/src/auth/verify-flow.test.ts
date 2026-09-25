import { AuthRetryableFetchError } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, failOnce, fakeAuth, fakeClock, tooSoon } from '../test/fake-auth'
import {
  codeVerificationReducer,
  createCodeVerification,
  type CodeVerificationOptions,
  type CodeVerificationState,
} from './verify-flow'

const base: CodeVerificationState = {
  purpose: 'signIn',
  email: 'a@b.co',
  status: 'idle',
  error: null,
  notice: null,
  resendAvailableAt: 0,
  retryAt: null,
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
    expect(
      codeVerificationReducer(resending, { type: 'resent', at: 5_000, retryAt: null }),
    ).toMatchObject({
      status: 'idle',
      notice: 'resent',
      resendAvailableAt: 65_000,
    })
  })

  it('keeps the countdown after an automatic resend on time; a late one moves it (D-073)', () => {
    // Planned for 35 s, so "Send a new code" waits until 95 s.
    const planned = { ...base, retryAt: 35_000, resendAvailableAt: 95_000 }
    const retrying = codeVerificationReducer(planned, { type: 'retry' })
    const onTime = codeVerificationReducer(retrying, { type: 'retried', at: 35_700, error: null })
    // Unchanged, so the countdown's screen-reader announcement is not repeated.
    expect(onTime).toEqual({ ...planned, retryAt: null })
    // Held back by a code check: a full cooldown after it.
    expect(
      codeVerificationReducer(retrying, { type: 'retried', at: 50_000, error: null }),
    ).toMatchObject({ resendAvailableAt: 110_000 })
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

describe('createCodeVerification: a request answered "too soon" is sent again once (D-073)', () => {
  const T = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })
  afterEach(() => vi.useRealTimers())

  function started(options: Partial<CodeVerificationOptions> = {}) {
    const fake = fakeAuth()
    const flow = createCodeVerification({
      auth: fake.auth,
      email: 'a@b.co',
      purpose: 'signIn',
      locale: 'en',
      ...options,
    })
    const stop = flow.start()
    return { flow, calls: fake.calls, stop }
  }

  it('sends the request from the sign-in page again at the handed-over time, with nothing on screen', async () => {
    const { flow, calls } = started({ retryAt: T + 35_000 })
    // The countdown covers the retry and the cooldown after it.
    expect(flow.getState()).toMatchObject({
      status: 'idle',
      notice: null,
      error: null,
      retryAt: T + 35_000,
      resendAvailableAt: T + 95_000,
    })
    const statuses: string[] = []
    flow.subscribe(() => statuses.push(flow.getState().status))

    await vi.advanceTimersByTimeAsync(34_999)
    expect(calls.signInWithOtp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    expect(calls.signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      options: { shouldCreateUser: true, data: { locale: 'en' } },
    })
    expect(flow.getState()).toMatchObject({ status: 'idle', notice: null, error: null })
    expect(flow.getState().retryAt).toBeNull()
    expect(statuses.every((status) => status === 'idle')).toBe(true)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
  })

  it('treats a resend answered "too soon" as sent and retries once, never twice', async () => {
    const { flow, calls } = started({ purpose: 'signUp', sentAt: T - 60_000 })
    failOnce(calls, 'resend', tooSoon(34))
    failOnce(calls, 'resend', tooSoon(3)) // the retry is answered "too soon" too
    await flow.resend()
    expect(flow.getState()).toMatchObject({
      status: 'idle',
      notice: 'resent',
      error: null,
      retryAt: T + 35_000,
      resendAvailableAt: T + 95_000,
    })

    await vi.advanceTimersByTimeAsync(35_000)
    expect(calls.resend).toHaveBeenCalledTimes(2)
    expect(calls.resend).toHaveBeenLastCalledWith({ type: 'signup', email: 'a@b.co' })
    expect(flow.getState()).toMatchObject({ notice: 'resent', error: null, retryAt: null })

    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls.resend).toHaveBeenCalledTimes(2)
  })

  it('waits the resend cooldown when the answer states no wait', async () => {
    const { flow, calls } = started({ sentAt: T - 60_000 })
    failOnce(calls, 'signInWithOtp', tooSoon())
    await flow.resend()
    expect(flow.getState()).toMatchObject({ retryAt: T + 61_000, resendAvailableAt: T + 121_000 })
    await vi.advanceTimersByTimeAsync(60_999)
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(2)
  })

  it('offers "Send a new code" only after the retry and its cooldown', async () => {
    const { flow, calls } = started({ retryAt: T + 35_000 })
    await vi.advanceTimersByTimeAsync(60_000) // the retry ran at 35 s
    await flow.resend()
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(35_000)
    await flow.resend()
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(2)
    expect(flow.getState().notice).toBe('resent')
  })

  it('is cancelled when the screen is left, and kept by a stop and start (React development)', async () => {
    const left = started({ retryAt: T + 35_000 })
    left.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(left.calls.signInWithOtp).not.toHaveBeenCalled()

    vi.setSystemTime(T)
    const shown = started({ retryAt: T + 35_000 })
    shown.stop()
    shown.flow.start()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(shown.calls.signInWithOtp).toHaveBeenCalledTimes(1)
  })

  it('never runs for a flow that was not started', async () => {
    const { auth, calls } = fakeAuth()
    createCodeVerification({ auth, email: 'a@b.co', purpose: 'signIn', locale: 'en', retryAt: T })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.signInWithOtp).not.toHaveBeenCalled()
  })

  it('is dropped once the code is verified', async () => {
    const { flow, calls } = started({ retryAt: T + 35_000 })
    expect(await flow.verify('123456')).toBe(true)
    expect(flow.getState().retryAt).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.signInWithOtp).not.toHaveBeenCalled()
  })

  it('waits for a code check in progress, then runs', async () => {
    const { flow, calls } = started({ retryAt: T + 35_000 })
    let answer: (value: unknown) => void = () => {}
    calls.verifyOtp.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const checking = flow.verify('000000')
    await vi.advanceTimersByTimeAsync(35_000)
    expect(calls.signInWithOtp).not.toHaveBeenCalled()
    answer({ data: { user: null, session: null }, error: apiError('otp_expired', 403) })
    expect(await checking).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.signInWithOtp).toHaveBeenCalledTimes(1)
    expect(flow.getState()).toMatchObject({ status: 'idle', error: 'auth.errors.codeInvalid' })
  })

  it('keeps the countdown when the retry goes out on time, and moves it when held back', async () => {
    const onTime = started({ retryAt: T + 35_000 })
    const countdowns = new Set<number>()
    onTime.flow.subscribe(() => countdowns.add(onTime.flow.getState().resendAvailableAt))
    await vi.advanceTimersByTimeAsync(35_000)
    expect(onTime.calls.signInWithOtp).toHaveBeenCalledTimes(1)
    expect([...countdowns]).toEqual([T + 95_000])

    // A code check that takes 10 s holds the retry back: "Send a new code" waits a cooldown after it.
    vi.setSystemTime(T)
    const late = started({ retryAt: T + 35_000 })
    let answer: (value: unknown) => void = () => {}
    late.calls.verifyOtp.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const checking = late.flow.verify('000000')
    await vi.advanceTimersByTimeAsync(45_000)
    answer({ data: { user: null, session: null }, error: apiError('otp_expired', 403) })
    await checking
    await vi.advanceTimersByTimeAsync(0)
    expect(late.calls.signInWithOtp).toHaveBeenCalledTimes(1)
    expect(late.flow.getState().resendAvailableAt).toBe(T + 105_000)
  })

  it('shows a real problem of the retry, like a resend', async () => {
    const { flow, calls } = started({ retryAt: T + 35_000 })
    failOnce(calls, 'signInWithOtp', new AuthRetryableFetchError('fetch failed', 0))
    await vi.advanceTimersByTimeAsync(35_000)
    expect(flow.getState()).toMatchObject({ status: 'idle', error: 'errors.network' })
  })

  it('drops a handed-over retry once its countdown is over, or one planned too far ahead', async () => {
    const stale = started({ sentAt: T - 200_000, retryAt: T - 100_000 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stale.calls.signInWithOtp).not.toHaveBeenCalled()
    expect(stale.flow.getState().retryAt).toBeNull()

    const edited = started({ retryAt: T + 3_600_000 }) // sessionStorage can be edited
    expect(edited.flow.getState()).toMatchObject({ retryAt: null })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(edited.calls.signInWithOtp).not.toHaveBeenCalled()
  })
})
