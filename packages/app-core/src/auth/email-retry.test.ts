import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, tooSoon } from '../test/fake-auth'
import {
  availableAfterRetry,
  createRetryTimer,
  emailRetryAt,
  MAX_RETRY_DELAY_MS,
  plannedRetryAt,
  sentRecently,
} from './email-retry'

describe('emailRetryAt', () => {
  it('waits the seconds the server states, plus one (it rounds them down)', () => {
    expect(emailRetryAt(tooSoon(34), 1_000)).toBe(1_000 + 35_000)
    expect(emailRetryAt(tooSoon(57), 0)).toBe(58_000)
  })

  it('clamps the stated wait to 1–65 seconds', () => {
    expect(emailRetryAt(tooSoon(0), 0)).toBe(2_000)
    expect(emailRetryAt(tooSoon(3_600), 0)).toBe(66_000)
    expect(emailRetryAt(tooSoon(Number.MAX_SAFE_INTEGER), 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('falls back to the resend cooldown when the message states no wait', () => {
    expect(emailRetryAt(tooSoon(), 0)).toBe(61_000)
    const blank = tooSoon(34)
    blank.message = ''
    expect(emailRetryAt(blank, 0)).toBe(61_000)
    expect(emailRetryAt({ code: 'over_email_send_rate_limit' }, 0)).toBe(61_000)
  })

  it('is only for over_email_send_rate_limit, whatever the message says', () => {
    const wording = 'For security purposes, you can only request this after 34 seconds.'
    for (const error of [
      apiError('over_request_rate_limit', 429),
      apiError('user_not_found', 404),
      new AuthApiError(wording, 429, undefined),
      new AuthRetryableFetchError(wording, 0),
      null,
      undefined,
      wording,
    ]) {
      expect(emailRetryAt(error, 0)).toBeNull()
    }
  })
})

describe('plannedRetryAt', () => {
  it('keeps a handed-over time no further ahead than a retry can be planned', () => {
    expect(plannedRetryAt(5_000, 0)).toBe(5_000)
    expect(plannedRetryAt(-5_000, 0)).toBe(-5_000) // overdue: the flow decides
    expect(plannedRetryAt(MAX_RETRY_DELAY_MS + 1, 0)).toBeNull()
    expect(plannedRetryAt(Number.POSITIVE_INFINITY, 0)).toBeNull()
    expect(plannedRetryAt(Number.NaN, 0)).toBeNull()
    expect(plannedRetryAt(undefined, 0)).toBeNull()
  })
})

describe('createRetryTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('runs only while started, and again after a stop and a new start', async () => {
    const run = vi.fn()
    const timer = createRetryTimer({ retryAt: () => 1_010_000, run, now: Date.now })
    timer.arm() // not started: nothing
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run).not.toHaveBeenCalled()

    const stop = timer.start()
    stop()
    stop() // a second call changes nothing
    const again = timer.start() // React runs effects twice in development
    expect(timer.started).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1) // overdue: at once
    again()
    expect(timer.started).toBe(false)
  })

  it('never waits longer than a retry can be planned', async () => {
    const run = vi.fn()
    const timer = createRetryTimer({ retryAt: () => Number.MAX_SAFE_INTEGER, run, now: Date.now })
    timer.start()
    await vi.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('sentRecently', () => {
  const sent = { email: 'A@b.co', sentAt: 100_000 }

  it('is true for the same address less than a cooldown after the send', () => {
    expect(sentRecently(sent, 'a@b.co', 100_000)).toBe(true)
    expect(sentRecently(sent, ' a@B.co ', 159_999)).toBe(true)
  })

  it('is false for another address, a send a cooldown ago or later, or one "in the future"', () => {
    expect(sentRecently(sent, 'other@b.co', 101_000)).toBe(false)
    expect(sentRecently(sent, 'a@b.co', 160_000)).toBe(false)
    expect(sentRecently(sent, 'a@b.co', 99_999)).toBe(false) // sessionStorage can be edited
    expect(sentRecently(null, 'a@b.co', 101_000)).toBe(false)
    expect(sentRecently(undefined, 'a@b.co', 101_000)).toBe(false)
  })
})

describe('availableAfterRetry', () => {
  // The countdown planned for a retry at 35 s: its cooldown ends at 95 s.
  const planned = 95_000

  it('keeps the countdown for a retry that went out on time (nothing is announced)', () => {
    expect(availableAfterRetry(planned, 35_000)).toBe(planned)
    expect(availableAfterRetry(planned, 37_000)).toBe(planned) // a slow network
  })

  it('moves it to a cooldown after a retry held back by a code check', () => {
    expect(availableAfterRetry(planned, 37_001)).toBe(97_001)
    expect(availableAfterRetry(planned, 50_000)).toBe(110_000)
  })
})
