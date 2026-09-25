import type { Locale } from '@bizcost/domain'
import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { authErrorKey, isSilentError, type AuthMessageKey } from './errors'

// The code screen after sign-up or "send me a code": verifyOtp(type 'email') and resend with a
// 60-second cooldown. Resending behaves the same whether or not the account exists ("send me a code"
// creates a missing account, D-062).

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
}

export type CodeVerificationEvent =
  | { type: 'verify' }
  | { type: 'verified' }
  | { type: 'resend' }
  | { type: 'resent'; at: number }
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
      return state.status === 'verifying' ? { ...state, status: 'verified', error: null } : state
    case 'resend':
      return busy(state) ? state : { ...state, status: 'resending', error: null, notice: null }
    case 'resent':
      return state.status === 'resending'
        ? {
            ...state,
            status: 'idle',
            notice: 'resent',
            resendAvailableAt: resendAvailableAt(event.at),
          }
        : state
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
  now?: () => number
}

export interface CodeVerification extends Flow<CodeVerificationState> {
  /** Verifies the code; resolves true once signed in. */
  verify(code: string): Promise<boolean>
  /** Sends a new code (ignored during the cooldown). */
  resend(): Promise<void>
}

export function createCodeVerification({
  auth,
  email,
  purpose,
  locale,
  now = Date.now,
  sentAt = now(),
}: CodeVerificationOptions): CodeVerification {
  const address = normalizeEmail(email)
  const store = createFlowStore(codeVerificationReducer, {
    purpose,
    email: address,
    status: 'idle',
    error: null,
    notice: null,
    resendAvailableAt: resendAvailableAt(sentAt),
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
      return false
    }
    store.dispatch({ type: 'verified' })
    return true
  }

  async function resend(): Promise<void> {
    if (now() < store.getState().resendAvailableAt) return
    if (!store.dispatch({ type: 'resend' })) return
    const { error } =
      purpose === 'signUp'
        ? await auth.resend({ type: 'signup', email: address })
        : await auth.signInWithOtp({
            email: address,
            options: { shouldCreateUser: true, data: { locale } },
          })
    if (error && !isSilentError(error, purpose === 'signUp' ? 'signUpResend' : 'signInCode')) {
      store.dispatch({ type: 'failed', error: authErrorKey(error) })
      return
    }
    store.dispatch({ type: 'resent', at: now() })
  }

  return { getState: store.getState, subscribe: store.subscribe, verify, resend }
}
