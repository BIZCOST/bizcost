import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { authErrorKey, isSilentError, type FlowError } from './errors'

// Secure email change (docs/ARCHITECTURE.md §Auth): updateUser({ email }) emails one code to the
// current address and one to the new address; each is verified with verifyOtp(type 'email_change')
// and its own address. The first accepted code is used up, so a retry only sends the other one.
// Asking for new codes calls updateUser again, which replaces both codes.
// An address that another account uses gets the same answer (no codes arrive), so the screen never
// tells whether it is registered.

export type EmailChangeField = 'newEmail' | 'currentCode' | 'newCode'

export interface EmailChangeState {
  step: 'start' | 'codes' | 'done'
  status: 'idle' | 'sending' | 'submitting'
  currentEmail: string
  /** The requested address (step 'codes' and 'done'). */
  newEmail: string | null
  currentCodeVerified: boolean
  newCodeVerified: boolean
  error: FlowError<EmailChangeField> | null
  notice: 'resent' | null
  resendAvailableAt: number
}

export type EmailChangeEvent =
  | { type: 'send'; newEmail: string }
  | { type: 'sent'; at: number }
  | { type: 'submit' }
  | { type: 'codeVerified'; which: 'current' | 'new' }
  | { type: 'done' }
  | { type: 'failed'; error: FlowError<EmailChangeField> }
  | { type: 'cancel' }

export function emailChangeReducer(
  state: EmailChangeState,
  event: EmailChangeEvent,
): EmailChangeState {
  const idle = state.status === 'idle' && state.step !== 'done'
  switch (event.type) {
    case 'send':
      return idle
        ? { ...state, status: 'sending', newEmail: event.newEmail, error: null, notice: null }
        : state
    case 'sent':
      return state.status === 'sending'
        ? {
            ...state,
            step: 'codes',
            status: 'idle',
            currentCodeVerified: false,
            newCodeVerified: false,
            notice: state.step === 'codes' ? 'resent' : null,
            resendAvailableAt: resendAvailableAt(event.at),
          }
        : state
    case 'submit':
      return idle && state.step === 'codes'
        ? { ...state, status: 'submitting', error: null, notice: null }
        : state
    case 'codeVerified':
      if (state.status !== 'submitting') return state
      return event.which === 'current'
        ? { ...state, currentCodeVerified: true }
        : { ...state, newCodeVerified: true }
    case 'done':
      return state.status === 'submitting' && state.newEmail
        ? { ...state, step: 'done', status: 'idle', currentEmail: state.newEmail, error: null }
        : state
    case 'failed':
      return state.step === 'done' ? state : { ...state, status: 'idle', error: event.error }
    case 'cancel':
      return state.status === 'idle'
        ? {
            ...state,
            step: 'start',
            newEmail: null,
            currentCodeVerified: false,
            newCodeVerified: false,
            error: null,
            notice: null,
          }
        : state
  }
}

export interface EmailChangeOptions {
  auth: AuthClient
  /** The signed-in user's email. */
  currentEmail: string
  now?: () => number
}

export interface EmailChange extends Flow<EmailChangeState> {
  /** Step 'start': requests the change. Step 'codes': sends new codes (after the cooldown). */
  sendCodes(newEmail?: string): Promise<void>
  /** Verifies the codes not verified yet; resolves true once the email is changed. */
  submit(input: { currentCode: string; newCode: string }): Promise<boolean>
  /** Back to 'start' (also after 'done'). */
  cancel(): void
}

export function createEmailChange({
  auth,
  currentEmail,
  now = Date.now,
}: EmailChangeOptions): EmailChange {
  const store = createFlowStore(emailChangeReducer, {
    step: 'start',
    status: 'idle',
    currentEmail: normalizeEmail(currentEmail),
    newEmail: null,
    currentCodeVerified: false,
    newCodeVerified: false,
    error: null,
    notice: null,
    resendAvailableAt: 0,
  })
  const fail = (error: FlowError<EmailChangeField>) => {
    store.dispatch({ type: 'failed', error })
    return false
  }

  async function sendCodes(requested?: string) {
    const state = store.getState()
    if (state.step === 'codes' && now() < state.resendAvailableAt) return
    const address = normalizeEmail(
      state.step === 'codes' ? (state.newEmail ?? '') : (requested ?? ''),
    )
    if (state.step === 'start' && state.status === 'idle') {
      if (!address) return void fail({ key: 'auth.validation.emailRequired', field: 'newEmail' })
      if (address === state.currentEmail) {
        return void fail({ key: 'account.email.sameEmail', field: 'newEmail' })
      }
    }
    if (!store.dispatch({ type: 'send', newEmail: address })) return
    const { error } = await auth.updateUser({ email: address })
    if (error && !isSilentError(error, 'emailChange')) {
      const key = authErrorKey(error)
      fail({ key, field: key === 'auth.validation.emailInvalid' ? 'newEmail' : undefined })
      return
    }
    store.dispatch({ type: 'sent', at: now() })
  }

  async function submit(input: { currentCode: string; newCode: string }) {
    const state = store.getState()
    if (state.step !== 'codes' || state.status !== 'idle' || !state.newEmail) return false
    const currentCode = normalizeCode(input.currentCode)
    const newCode = normalizeCode(input.newCode)
    if (!state.currentCodeVerified && !isCompleteCode(currentCode)) {
      return fail({ key: 'auth.validation.codeIncomplete', field: 'currentCode' })
    }
    if (!state.newCodeVerified && !isCompleteCode(newCode)) {
      return fail({ key: 'auth.validation.codeIncomplete', field: 'newCode' })
    }
    if (!store.dispatch({ type: 'submit' })) return false

    const steps = [
      { which: 'current', email: state.currentEmail, token: currentCode, field: 'currentCode' },
      { which: 'new', email: state.newEmail, token: newCode, field: 'newCode' },
    ] as const
    for (const step of steps) {
      const verified = store.getState()[`${step.which}CodeVerified`]
      if (verified) continue
      const { error } = await auth.verifyOtp({
        email: step.email,
        token: step.token,
        type: 'email_change',
      })
      if (error) {
        const key = authErrorKey(error)
        return fail({ key, field: key === 'auth.errors.codeInvalid' ? step.field : undefined })
      }
      store.dispatch({ type: 'codeVerified', which: step.which })
    }
    store.dispatch({ type: 'done' })
    return true
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    sendCodes,
    submit,
    cancel: () => void store.dispatch({ type: 'cancel' }),
  }
}
