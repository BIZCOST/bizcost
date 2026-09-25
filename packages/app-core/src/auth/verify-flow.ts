import type { Locale } from '@bizcost/domain'
import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { availableAfterRetry, createRetryTimer, emailRetryAt, plannedRetryAt } from './email-retry'
import { authErrorKey, isSilentError, type AuthMessageKey } from './errors'

// The code screen after sign-up or "send me a code": verifyOtp(type 'email') and resend with a
// 60-second cooldown. Resending behaves the same whether or not the account exists ("send me a code"
// creates a missing account, D-062). A request the server answered "too soon" is sent again once,
// unseen, while the screen is open (D-073).

export type CodePurpose = 'signUp' | 'signIn'

export interface CodeVerificationState {
  purpose: CodePurpose
  email: string
  status: 'idle' | 'verifying' | 'resending' | 'verified'
  error: AuthMessageKey | null
  /** Set after a successful resend until the next action. */
  notice: 'resent' | null
  /** Epoch ms when "Send a new code" becomes available. */
  resendAvailableAt: number
  /**
   * Epoch ms of the one automatic resend after a "too soon" answer (D-073); null when none is
   * planned or it has run. Not shown on screen.
   */
  retryAt: number | null
}

export type CodeVerificationEvent =
  | { type: 'verify' }
  | { type: 'verified' }
  | { type: 'resend' }
  | { type: 'resent'; at: number; retryAt: number | null }
  | { type: 'retry' }
  | { type: 'retried'; at: number; error: AuthMessageKey | null }
  | { type: 'failed'; error: AuthMessageKey }

const busy = (s: CodeVerificationState) => s.status !== 'idle'

export function codeVerificationReducer(
  state: CodeVerificationState,
  event: CodeVerificationEvent,
): CodeVerificationState {
  switch (event.type) {
    case 'verify':
      return busy(state) ? state : { ...state, status: 'verifying', error: null, notice: null }
    case 'verified':
      return state.status === 'verifying'
        ? { ...state, status: 'verified', error: null, retryAt: null }
        : state
    case 'resend':
      return busy(state)
        ? state
        : { ...state, status: 'resending', error: null, notice: null, retryAt: null }
    case 'resent':
      return state.status === 'resending'
        ? {
            ...state,
            status: 'idle',
            notice: 'resent',
            resendAvailableAt: resendAvailableAt(event.at, event.retryAt),
            retryAt: event.retryAt,
          }
        : state
    // The automatic resend changes nothing on screen: it starts only while idle and never sets a
    // status, a notice or a new countdown (the countdown already covers it; only a resend held back
    // by a code check moves it).
    case 'retry':
      return state.status === 'idle' && state.retryAt !== null ? { ...state, retryAt: null } : state
    case 'retried':
      if (state.status === 'verified') return state
      return {
        ...state,
        resendAvailableAt: availableAfterRetry(state.resendAvailableAt, event.at),
        error: event.error && state.status === 'idle' ? event.error : state.error,
      }
    case 'failed':
      return state.status === 'verified' ? state : { ...state, status: 'idle', error: event.error }
  }
}

export interface CodeVerificationOptions {
  auth: AuthClient
  email: string
  purpose: CodePurpose
  /** The page language: the emails' language if a sign-in code request creates the account. */
  locale: Locale
  /** When the first code was sent (epoch ms); default now. */
  sentAt?: number
  /**
   * The request that brought the user here was answered "too soon": send it again once at this
   * time (epoch ms, from `requestSignInCode` or `signInWithPassword`, D-073).
   */
  retryAt?: number
  now?: () => number
}

export interface CodeVerification extends Flow<CodeVerificationState> {
  /** Verifies the code; resolves true once signed in. */
  verify(code: string): Promise<boolean>
  /** Sends a new code (ignored during the cooldown). */
  resend(): Promise<void>
  /** Runs the planned automatic resend while the screen is shown; returns the stop function. */
  start(): () => void
}

export function createCodeVerification({
  auth,
  email,
  purpose,
  locale,
  now = Date.now,
  sentAt = now(),
  retryAt,
}: CodeVerificationOptions): CodeVerification {
  const address = normalizeEmail(email)
  const planned = plannedRetryAt(retryAt, now())
  const store = createFlowStore(codeVerificationReducer, {
    purpose,
    email: address,
    status: 'idle',
    error: null,
    notice: null,
    resendAvailableAt: resendAvailableAt(sentAt, planned),
    retryAt: planned,
  })
  const request = () =>
    purpose === 'signUp'
      ? auth.resend({ type: 'signup', email: address })
      : auth.signInWithOtp({
          email: address,
          options: { shouldCreateUser: true, data: { locale } },
        })
  const hidden = (error: unknown) =>
    isSilentError(error, purpose === 'signUp' ? 'signUpResend' : 'signInCode')
  const timer = createRetryTimer({
    retryAt: () => store.getState().retryAt,
    run: () => void retry(),
    now,
  })

  async function verify(input: string): Promise<boolean> {
    const token = normalizeCode(input)
    if (!isCompleteCode(token)) {
      if (!busy(store.getState())) {
        store.dispatch({ type: 'failed', error: 'auth.validation.codeIncomplete' })
      }
      return false
    }
    if (!store.dispatch({ type: 'verify' })) return false
    const { error } = await auth.verifyOtp({ email: address, token, type: 'email' })
    if (error) {
      store.dispatch({ type: 'failed', error: authErrorKey(error) })
      // A retry that came due while the code was being checked runs now.
      void retry()
      return false
    }
    store.dispatch({ type: 'verified' })
    return true
  }

  async function resend(): Promise<void> {
    if (now() < store.getState().resendAvailableAt) return
    if (!store.dispatch({ type: 'resend' })) return
    const { error } = await request()
    if (error && !hidden(error)) {
      store.dispatch({ type: 'failed', error: authErrorKey(error) })
      return
    }
    const at = now()
    store.dispatch({ type: 'resent', at, retryAt: emailRetryAt(error, at) })
    timer.arm()
  }

  /** The one automatic resend (D-073), handled like a resend but without anything on screen. */
  async function retry(): Promise<void> {
    const state = store.getState()
    if (!timer.started || state.retryAt === null) return
    if (now() < state.retryAt) return timer.arm()
    // Once the countdown is over the user can ask for a new code: the retry is dropped.
    const due = now() < state.resendAvailableAt
    if (!store.dispatch({ type: 'retry' }) || !due) return
    const { error } = await request()
    // A second "too soon" is not retried again.
    const shown = error && !hidden(error) ? authErrorKey(error) : null
    store.dispatch({ type: 'retried', at: now(), error: shown })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    verify,
    resend,
    start: timer.start,
  }
}
