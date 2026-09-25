import { createFlowStore, type Flow } from '../flow'
import type { AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { authErrorKey, passwordErrorField, type FlowError } from './errors'
import { sendIdentityCode, verifyIdentityCode } from './identity-flow'

// Change password from the account screen (docs/ARCHITECTURE.md §Auth, D-063): a "confirm it's you"
// code is emailed first (identity-flow.ts), Supabase Auth checks it (verifyOtp), then
// updateUser({ password }). A wrong code is refused by the server. A verified code is used up, so
// when only the password is rejected the next submit skips the code.

export type PasswordChangeField = 'code' | 'password'

export interface PasswordChangeState {
  step: 'start' | 'code' | 'done'
  status: 'idle' | 'sending' | 'submitting'
  /** The code was accepted; only the password is left. */
  codeVerified: boolean
  error: FlowError<PasswordChangeField> | null
  notice: 'resent' | null
  resendAvailableAt: number
}

export type PasswordChangeEvent =
  | { type: 'send' }
  | { type: 'sent'; at: number }
  | { type: 'submit' }
  | { type: 'codeVerified' }
  | { type: 'done' }
  | { type: 'failed'; error: FlowError<PasswordChangeField> }
  | { type: 'cancel' }

const INITIAL: PasswordChangeState = {
  step: 'start',
  status: 'idle',
  codeVerified: false,
  error: null,
  notice: null,
  resendAvailableAt: 0,
}

export function passwordChangeReducer(
  state: PasswordChangeState,
  event: PasswordChangeEvent,
): PasswordChangeState {
  const idle = state.status === 'idle' && state.step !== 'done'
  switch (event.type) {
    case 'send':
      return idle && !state.codeVerified
        ? { ...state, status: 'sending', error: null, notice: null }
        : state
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
    case 'submit':
      return idle && state.step === 'code'
        ? { ...state, status: 'submitting', error: null, notice: null }
        : state
    case 'codeVerified':
      return state.status === 'submitting' ? { ...state, codeVerified: true } : state
    case 'done':
      return state.status === 'submitting' ? { ...INITIAL, step: 'done' } : state
    case 'failed':
      return state.step === 'done' ? state : { ...state, status: 'idle', error: event.error }
    case 'cancel':
      return state.status === 'idle' ? INITIAL : state
  }
}

export interface PasswordChangeOptions {
  auth: AuthClient
  /** The signed-in user's email (the code goes there). */
  email: string
  now?: () => number
}

export interface PasswordChange extends Flow<PasswordChangeState> {
  /** Emails the code (step 'start' → 'code'); on step 'code', resends it after the cooldown. */
  sendCode(): Promise<void>
  submit(input: { code: string; password: string }): Promise<boolean>
  /** Back to 'start' (also after 'done', to change it again). */
  cancel(): void
}

export function createPasswordChange({
  auth,
  email,
  now = Date.now,
}: PasswordChangeOptions): PasswordChange {
  const store = createFlowStore(passwordChangeReducer, INITIAL)
  const fail = (error: FlowError<PasswordChangeField>) => {
    store.dispatch({ type: 'failed', error })
    return false
  }

  async function sendCode() {
    const state = store.getState()
    if (state.step === 'code' && now() < state.resendAvailableAt) return
    if (!store.dispatch({ type: 'send' })) return
    const { error } = await sendIdentityCode(auth, email)
    if (error) {
      fail({ key: authErrorKey(error) })
      return
    }
    store.dispatch({ type: 'sent', at: now() })
  }

  async function submit({ code, password }: { code: string; password: string }) {
    const token = normalizeCode(code)
    const state = store.getState()
    if (state.step !== 'code' || state.status !== 'idle') return false
    if (!state.codeVerified && !isCompleteCode(token)) {
      return fail({ key: 'auth.validation.codeIncomplete', field: 'code' })
    }
    if (!store.dispatch({ type: 'submit' })) return false
    if (!state.codeVerified) {
      const { error } = await verifyIdentityCode(auth, email, token)
      if (error) {
        const key = authErrorKey(error)
        return fail({ key, field: key === 'auth.errors.codeInvalid' ? 'code' : undefined })
      }
      store.dispatch({ type: 'codeVerified' })
    }
    const { error } = await auth.updateUser({ password })
    if (error) {
      const key = authErrorKey(error)
      return fail({ key, field: passwordErrorField(key, 'password') })
    }
    store.dispatch({ type: 'done' })
    return true
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    sendCode,
    submit,
    cancel: () => void store.dispatch({ type: 'cancel' }),
  }
}
