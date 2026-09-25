import { AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { normalizeEmail } from './client'
import { resendAvailableAt } from './code'
import { authErrorCode } from './errors'

// "Too soon" (D-073). Supabase Auth emails an address at most once per `[auth.email]
// max_frequency` (60 s), across sign-up and sign-in codes and resets, and answers a request inside
// that window with 429 `over_email_send_rate_limit`. The code requests treat that answer like
// success, because showing it would tell a recently emailed (so registered) address apart (D-062),
// so nothing was sent although the screen says a code was. They therefore send the same request
// once more, when the server says it may, while the code screen is open, unless the email inside
// the window is the one this tab just asked for with the same request (its code still works).

/** The server rounds its wait down to whole seconds: one more second makes sure it has passed. */
const MARGIN_MS = 1000
const MIN_WAIT_SECONDS = 1
const MAX_WAIT_SECONDS = 65
/** How late the automatic resend may go out before the resend countdown is moved for it. */
const LATE_MS = 2000
const COOLDOWN_MS = AUTH_RESEND_COOLDOWN_SECONDS * 1000

/** The longest a retry can be planned ahead (the clamped wait plus the margin). */
export const MAX_RETRY_DELAY_MS = MAX_WAIT_SECONDS * 1000 + MARGIN_MS

/**
 * When to send a code request again after it answered `error` (epoch ms), or null when `error` is
 * not `over_email_send_rate_limit`. The wait comes from the message ("…you can only request this
 * after 34 seconds."), clamped to 1–65 s, else AUTH_RESEND_COOLDOWN_SECONDS; plus one second. This is
 * the only place an auth message text is read, only for that number, never to choose what to show.
 */
export function emailRetryAt(error: unknown, now: number): number | null {
  if (authErrorCode(error) !== 'over_email_send_rate_limit') return null
  const message = (error as { message?: unknown }).message
  const stated = typeof message === 'string' ? /after (\d+) seconds?/i.exec(message) : null
  const seconds = stated?.[1]
    ? Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Number(stated[1])))
    : AUTH_RESEND_COOLDOWN_SECONDS
  return now + seconds * 1000 + MARGIN_MS
}

/**
 * The code this tab last asked for with the same request (the same purpose), when it went out: no
 * automatic resend is planned for it and it has not been used (on the web, the pending entry).
 */
export interface SentCode {
  email: string
  /** When it was sent (epoch ms). */
  sentAt: number
}

/**
 * True when `sent` went to `email` less than a cooldown before `now`. A "too soon" answer to the
 * same request is then about that email, whose code still works: nothing is sent again (a new email
 * would replace that code) and the usual countdown starts, the same screen as for an address without
 * an account asking twice.
 */
export function sentRecently(
  sent: SentCode | null | undefined,
  email: string,
  now: number,
): boolean {
  if (!sent || normalizeEmail(sent.email) !== normalizeEmail(email)) return false
  const age = now - sent.sentAt
  return age >= 0 && age < COOLDOWN_MS
}

/**
 * The resend countdown (`availableAt`, epoch ms) after the automatic resend went out at `at`. It
 * already covers a resend on time, so it stays as it is (a new value would be announced to screen
 * readers); only a resend held back (by a code check) moves it to a cooldown after `at`.
 */
export function availableAfterRetry(availableAt: number, at: number): number {
  const needed = resendAvailableAt(at)
  return needed > availableAt + LATE_MS ? needed : availableAt
}

/**
 * A retry time handed over from another page (sessionStorage, which the user can edit): kept only
 * when it is a number no further ahead than a retry can be planned.
 */
export function plannedRetryAt(value: number | undefined, now: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value <= now + MAX_RETRY_DELAY_MS
    ? value
    : null
}

export interface RetryTimer {
  /** (Re)arms the timer for the flow's planned retry; call after planning one. */
  arm(): void
  /** Arms the timer until the returned function is called (the flow's `start`). */
  start(): () => void
  /** True while at least one `start` is running. */
  readonly started: boolean
}

/**
 * The timer of a flow's one automatic resend: it waits for `retryAt()` only while the flow is
 * started (a screen shows it), so leaving the page cancels it. Stopping and starting again (React
 * runs effects twice in development) arms it again for the same time. `run` decides whether the
 * retry is still wanted.
 */
export function createRetryTimer({
  retryAt,
  run,
  now,
}: {
  retryAt: () => number | null
  run: () => void
  now: () => number
}): RetryTimer {
  let starts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const arm = () => {
    clear()
    const at = retryAt()
    if (starts === 0 || at === null) return
    const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - now()))
    timer = setTimeout(() => {
      timer = undefined
      run()
    }, delay)
  }
  return {
    arm,
    start() {
      starts += 1
      arm()
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        starts -= 1
        if (starts === 0) clear()
      }
    },
    get started() {
      return starts > 0
    },
  }
}
