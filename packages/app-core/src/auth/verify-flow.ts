import type { Locale } from '@bizcost/domain'
import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { availableAfterRetry, createRetryTimer, emailRetryAt, plannedRetryAt } from './email-retry'
import { authErrorCode, authErrorKey, isSilentError, type AuthMessageKey } from './errors'

// The code screen after sign-up or "send me a code": verifyOtp(type 'email') and resend with a
// 60-second cooldown. Resending behaves the same whether or not the account exists ("send me a code"
// creates a missing account, D-062). A request the server answered "too soon" is sent again once,
// unseen, while the screen is open (D-073).
//
// A code that confirms an address drops any password chosen before (a database rule, D-102: whoever
// signed up first with the address chose it). So after a sign-up code the flow sets the password
// the sign-up (or a password sign-in of an unconfirmed email) was given, with the session the code
// created; when the page no longer has it (a reload), the user chooses one.

export type CodePurpose = 'signUp' | 'signIn'

export interface CodeVerificationState {
  purpose: CodePurpose
  email: string
  /**
   * `password`: the code was accepted (signed in) and the user chooses the password the page lost,
   * or one the Auth server refused; `saving`: it is being set. `verified`: done.
   */
  status: 'idle' | 'verifying' | 'resending' | 'password' | 'saving' | 'verified'
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
  | { type: 'choosePassword'; error: AuthMessageKey | null }
  | { type: 'save' }
  | { type: 'resend' }
  | { type: 'resent'; at: number; retryAt: number | null }
  | { type: 'retry' }
  | { type: 'retried'; at: number; error: AuthMessageKey | null }
  | { type: 'failed'; error: AuthMessageKey }

const busy = (s: CodeVerificationState) => s.status !== 'idle'

/** The code was accepted: nothing of the code step (a resend, its retry or error) applies any more. */
export const codeAccepted = (s: Pick<CodeVerificationState, 'status'>) =>
  s.status === 'password' || s.status === 'saving' || s.status === 'verified'

export function codeVerificationReducer(
  state: CodeVerificationState,
  event: CodeVerificationEvent,
): CodeVerificationState {
  switch (event.type) {
    case 'verify':
      return busy(state) ? state : { ...state, status: 'verifying', error: null, notice: null }
    case 'verified':
      return state.status === 'verifying' || state.status === 'saving'
        ? { ...state, status: 'verified', error: null, retryAt: null }
        : state
    case 'choosePassword':
      return state.status === 'verifying' || state.status === 'saving'
        ? { ...state, status: 'password', error: event.error, notice: null, retryAt: null }
        : state
    case 'save':
      return state.status === 'password' ? { ...state, status: 'saving', error: null } : state
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
      if (codeAccepted(state)) return state
      return {
        ...state,
        resendAvailableAt: availableAfterRetry(state.resendAvailableAt, event.at),
        error: event.error && state.status === 'idle' ? event.error : state.error,
      }
    case 'failed':
      return codeAccepted(state) ? state : { ...state, status: 'idle', error: event.error }
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
  /**
   * A sign-up code (D-102): the password this page was given for the address (the sign-up form, or
   * a password sign-in of an unconfirmed email), set again once the code confirmed the address; null
   * when the page lost it (a reload), and the user chooses one. Left out: no password ("Send me a
   * code").
   */
  password?: string | null
  now?: () => number
}

export interface CodeVerification extends Flow<CodeVerificationState> {
  /**
   * Verifies the code; resolves true once done: signed in and, after a sign-up code, the password
   * set. False also when the password step follows (`status: 'password'`).
   */
  verify(code: string): Promise<boolean>
  /** Sets the password the user chose after the code; resolves true once done. */
  savePassword(password: string): Promise<boolean>
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
  password,
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
    if (password === undefined) {
      store.dispatch({ type: 'verified' })
      return true
    }
    if (password === null) {
      store.dispatch({ type: 'choosePassword', error: null })
      return false
    }
    // Still "checking the code" on screen: the user sees one step.
    return setPassword(password)
  }

  /**
   * Sets the password through the session the code created. "Same password" means it is already
   * the one (the database rule is not there yet): done. Any other refusal (e.g. an old password that
   * no longer meets the rule, D-072, or the network) asks the user.
   */
  async function setPassword(value: string): Promise<boolean> {
    const { error } = await auth.updateUser({ password: value })
    if (error && authErrorCode(error) !== 'same_password') {
      store.dispatch({ type: 'choosePassword', error: authErrorKey(error) })
      return false
    }
    store.dispatch({ type: 'verified' })
    return true
  }

  async function savePassword(value: string): Promise<boolean> {
    if (!store.dispatch({ type: 'save' })) return false
    return setPassword(value)
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
    savePassword,
    resend,
    start: timer.start,
  }
}
