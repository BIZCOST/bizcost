import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { authErrorKey, type AuthMessageKey } from './errors'

// "Confirm it's you" for sensitive account actions (change password, delete account; D-063): a code
// is emailed to the signed-in user's own address (signInWithOtp, the sign-in code) and checked by
// Supabase Auth with verifyOtp(type 'email'), which also starts a new session. A wrong code is refused
// by the server. Supabase's reauthenticate() nonce is not used: Supabase checks it only for sessions
// older than 24 hours, so on a newer session any code would pass.

/** Emails the "confirm it's you" code to the signed-in user (the account exists: never creates one). */
export function sendIdentityCode(auth: AuthClient, email: string) {
  return auth.signInWithOtp({ email: normalizeEmail(email), options: { shouldCreateUser: false } })
}

/** Checks the code with Supabase Auth; on success the session is renewed (a fresh sign-in time). */
export function verifyIdentityCode(auth: AuthClient, email: string, code: string) {
  return auth.verifyOtp({ email: normalizeEmail(email), token: code, type: 'email' })
}

export interface IdentityCheckState {
  step: 'start' | 'code' | 'confirmed'
  status: 'idle' | 'sending' | 'verifying'
  error: AuthMessageKey | null
  notice: 'resent' | null
  resendAvailableAt: number
}

export type IdentityCheckEvent =
  | { type: 'send' }
  | { type: 'sent'; at: number }
  | { type: 'verify' }
  | { type: 'confirmed' }
  | { type: 'failed'; error: AuthMessageKey }
  | { type: 'reset' }

const INITIAL: IdentityCheckState = {
  step: 'start',
  status: 'idle',
  error: null,
  notice: null,
  resendAvailableAt: 0,
}

export function identityCheckReducer(
  state: IdentityCheckState,
  event: IdentityCheckEvent,
): IdentityCheckState {
  const idle = state.status === 'idle' && state.step !== 'confirmed'
  switch (event.type) {
    case 'send':
      return idle ? { ...state, status: 'sending', error: null, notice: null } : state
    case 'sent':
      return state.status === 'sending'
        ? {
            ...state,
            step: 'code',
            status: 'idle',
            notice: state.step === 'code' ? 'resent' : null,
            resendAvailableAt: resendAvailableAt(event.at),
          }
        : state
    case 'verify':
      return idle && state.step === 'code'
        ? { ...state, status: 'verifying', error: null, notice: null }
        : state
    case 'confirmed':
      return state.status === 'verifying' ? { ...INITIAL, step: 'confirmed' } : state
    case 'failed':
      return state.step === 'confirmed' ? state : { ...state, status: 'idle', error: event.error }
    case 'reset':
      return state.status === 'idle' ? INITIAL : state
  }
}

export interface IdentityCheckOptions {
  auth: AuthClient
  /** The signed-in user's email. */
  email: string
  now?: () => number
}

export interface IdentityCheck extends Flow<IdentityCheckState> {
  /** Emails the code (step 'start' → 'code'); on step 'code', sends a new one after the cooldown. */
  sendCode(): Promise<void>
  /** Checks the code; resolves true once confirmed. */
  confirm(code: string): Promise<boolean>
  /** Back to 'start' (e.g. when the dialog closes). */
  reset(): void
}

export function createIdentityCheck({
  auth,
  email,
  now = Date.now,
}: IdentityCheckOptions): IdentityCheck {
  const store = createFlowStore(identityCheckReducer, INITIAL)

  async function sendCode() {
    const state = store.getState()
    if (state.step === 'code' && now() < state.resendAvailableAt) return
    if (!store.dispatch({ type: 'send' })) return
    const { error } = await sendIdentityCode(auth, email)
    if (error) {
      store.dispatch({ type: 'failed', error: authErrorKey(error) })
      return
    }
    store.dispatch({ type: 'sent', at: now() })
  }

  async function confirm(input: string) {
    const code = normalizeCode(input)
    const state = store.getState()
    if (state.step !== 'code' || state.status !== 'idle') return false
    if (!isCompleteCode(code)) {
      store.dispatch({ type: 'failed', error: 'auth.validation.codeIncomplete' })
      return false
    }
    if (!store.dispatch({ type: 'verify' })) return false
    const { error } = await verifyIdentityCode(auth, email, code)
    if (error) {
      store.dispatch({ type: 'failed', error: authErrorKey(error) })
      return false
    }
    store.dispatch({ type: 'confirmed' })
    return true
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    sendCode,
    confirm,
    reset: () => void store.dispatch({ type: 'reset' }),
  }
}
