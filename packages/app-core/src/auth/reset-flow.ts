import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { authErrorKey, isSilentError, passwordErrorField, type FlowError } from './errors'

// The reset screen after "Forgot password": code + new password on one form.
// verifyOtp(type 'recovery') signs the user in; updateUser({ password }) then sets the password
// (Supabase Auth also ends the user's other sessions). A verified code is used up, so when only the
// password is rejected the next submit skips the code.

export type ResetField = 'code' | 'password'

export interface PasswordResetState {
  email: string
  /** The code was accepted (the user is signed in); only the password is left. */
  codeVerified: boolean
  status: 'idle' | 'submitting' | 'resending' | 'done'
  error: FlowError<ResetField> | null
  notice: 'resent' | null
  resendAvailableAt: number
}

export type PasswordResetEvent =
  | { type: 'submit' }
  | { type: 'codeVerified' }
  | { type: 'done' }
  | { type: 'resend' }
  | { type: 'resent'; at: number }
  | { type: 'failed'; error: FlowError<ResetField> }

const busy = (s: PasswordResetState) => s.status !== 'idle'

export function passwordResetReducer(
  state: PasswordResetState,
  event: PasswordResetEvent,
): PasswordResetState {
  switch (event.type) {
    case 'submit':
      return busy(state) ? state : { ...state, status: 'submitting', error: null, notice: null }
    case 'codeVerified':
      return state.status === 'submitting' ? { ...state, codeVerified: true } : state
    case 'done':
      return state.status === 'submitting' ? { ...state, status: 'done', error: null } : state
    case 'resend':
      return busy(state) || state.codeVerified
        ? state
        : { ...state, status: 'resending', error: null, notice: null }
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
      return state.status === 'done' ? state : { ...state, status: 'idle', error: event.error }
  }
}

export interface PasswordResetOptions {
  auth: AuthClient
  email: string
  sentAt?: number
  now?: () => number
}

export interface PasswordReset extends Flow<PasswordResetState> {
  /** Verifies the code (unless already done) and saves the new password; resolves true when done. */
  submit(input: { code: string; password: string }): Promise<boolean>
  resend(): Promise<void>
}

export function createPasswordReset({
  auth,
  email,
  now = Date.now,
  sentAt = now(),
}: PasswordResetOptions): PasswordReset {
  const address = normalizeEmail(email)
  const store = createFlowStore(passwordResetReducer, {
    email: address,
    codeVerified: false,
    status: 'idle',
    error: null,
    notice: null,
    resendAvailableAt: resendAvailableAt(sentAt),
  })
  const fail = (error: FlowError<ResetField>) => {
    store.dispatch({ type: 'failed', error })
    return false
  }

  async function submit({ code, password }: { code: string; password: string }) {
    const token = normalizeCode(code)
    if (!store.getState().codeVerified && !isCompleteCode(token)) {
      return busy(store.getState())
        ? false
        : fail({ key: 'auth.validation.codeIncomplete', field: 'code' })
    }
    if (!store.dispatch({ type: 'submit' })) return false
    if (!store.getState().codeVerified) {
      const { error } = await auth.verifyOtp({ email: address, token, type: 'recovery' })
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

  async function resend() {
    const state = store.getState()
    if (state.codeVerified || now() < state.resendAvailableAt) return
    if (!store.dispatch({ type: 'resend' })) return
    const { error } = await auth.resetPasswordForEmail(address)
    if (error && !isSilentError(error, 'recovery')) {
      store.dispatch({ type: 'failed', error: { key: authErrorKey(error) } })
      return
    }
    store.dispatch({ type: 'resent', at: now() })
  }

  return { getState: store.getState, subscribe: store.subscribe, submit, resend }
}
