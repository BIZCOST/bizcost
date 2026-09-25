import { createFlowStore, type Flow } from '../flow'
import { normalizeEmail, type AuthClient } from './client'
import { isCompleteCode, normalizeCode, resendAvailableAt } from './code'
import { signOut } from './commands'
import { authErrorKey, isSilentError, passwordErrorField, type FlowError } from './errors'

// The reset screen after "Forgot password" (D-071): only the emailed code first. verifyOtp(type
// 'recovery') checks it and signs the user in; the user then chooses to set a new password
// (updateUser({ password }); Supabase Auth also ends their other sessions) or to go straight in.
// When the code is what confirmed the address (the account was never confirmed, so its password was
// set by whoever signed up with it), a new password is required: no choice, no way back to it.
// The new password is sent only from the flow that verified the code, and only through the session
// that code created (the recovery code is the D-063 check); otherwise this device is signed out.

export type ResetField = 'code' | 'password'

/**
 * code → choose → password (optional) → done, or code → password → done when a new password is
 * required. Opened again after the code was used (a reload, Back): resuming → signedIn (→ done)
 * when this device is still signed in and no password is required, else ended.
 * ended: this device is signed out and the password was not changed; restart asks for a new code.
 */
export type ResetStep = 'code' | 'choose' | 'password' | 'done' | 'resuming' | 'signedIn' | 'ended'

export interface PasswordResetState {
  email: string
  step: ResetStep
  status: 'idle' | 'verifying' | 'resending' | 'saving' | 'checking'
  /** The code confirmed the address: the user must set a new password (no skip, no back). */
  passwordRequired: boolean
  /** On step 'done': true when a new password was saved, false when the user went straight in. */
  passwordChanged: boolean
  error: FlowError<ResetField> | null
  notice: 'resent' | null
  resendAvailableAt: number
}

export type PasswordResetEvent =
  | { type: 'verify' }
  | { type: 'verified'; passwordRequired: boolean }
  | { type: 'resend' }
  | { type: 'resent'; at: number }
  | { type: 'choosePassword' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'save' }
  | { type: 'saved' }
  | { type: 'resume' }
  | { type: 'resumed' }
  | { type: 'sessionEnded' }
  | { type: 'restart' }
  | { type: 'failed'; error: FlowError<ResetField> }

const idleOn = (s: PasswordResetState, ...steps: ResetStep[]) =>
  steps.includes(s.step) && s.status === 'idle'

export function passwordResetReducer(
  state: PasswordResetState,
  event: PasswordResetEvent,
): PasswordResetState {
  switch (event.type) {
    case 'verify':
      return idleOn(state, 'code')
        ? { ...state, status: 'verifying', error: null, notice: null }
        : state
    case 'verified': {
      if (state.status !== 'verifying') return state
      const passwordRequired = state.passwordRequired || event.passwordRequired
      return {
        ...state,
        step: passwordRequired ? 'password' : 'choose',
        status: 'idle',
        passwordRequired,
        error: null,
        notice: null,
      }
    }
    case 'resend':
      return idleOn(state, 'code')
        ? { ...state, status: 'resending', error: null, notice: null }
        : state
    case 'resent':
      return state.status === 'resending'
        ? {
            ...state,
            status: 'idle',
            notice: 'resent',
            resendAvailableAt: resendAvailableAt(event.at),
          }
        : state
    case 'choosePassword':
      return idleOn(state, 'choose') ? { ...state, step: 'password', error: null } : state
    case 'back':
      return idleOn(state, 'password') && !state.passwordRequired
        ? { ...state, step: 'choose', error: null }
        : state
    case 'skip':
      return idleOn(state, 'choose', 'signedIn') && !state.passwordRequired
        ? { ...state, step: 'done', passwordChanged: false, error: null }
        : state
    case 'save':
      return idleOn(state, 'password') ? { ...state, status: 'saving', error: null } : state
    case 'saved':
      return state.status === 'saving'
        ? { ...state, step: 'done', status: 'idle', passwordChanged: true, error: null }
        : state
    case 'resume':
      return idleOn(state, 'resuming') ? { ...state, status: 'checking' } : state
    case 'resumed':
      return state.step === 'resuming' && !state.passwordRequired
        ? { ...state, step: 'signedIn', status: 'idle' }
        : state
    case 'sessionEnded':
      return state.step === 'choose' || state.step === 'password' || state.step === 'resuming'
        ? { ...state, step: 'ended', status: 'idle', error: null }
        : state
    case 'restart':
      return idleOn(state, 'ended') ? { ...state, step: 'code', error: null, notice: null } : state
    case 'failed':
      return state.step === 'done' || state.step === 'ended'
        ? state
        : { ...state, status: 'idle', error: event.error }
  }
}

export interface PasswordResetOptions {
  auth: AuthClient
  email: string
  /** When the code was sent (epoch ms); default now. */
  sentAt?: number
  /**
   * The code was already used in this tab (the page was opened again): the flow starts at
   * 'resuming' and `resume()` decides where the user is.
   */
  codeUsed?: boolean
  /** A new password is required (carried over from an earlier code of this reset). */
  passwordRequired?: boolean
  now?: () => number
}

export interface PasswordReset extends Flow<PasswordResetState> {
  /**
   * Checks the code; resolves true once it is accepted (the user is signed in; step 'choose', or
   * 'password' when a new password is required).
   */
  verify(code: string): Promise<boolean>
  /** Sends a new code (step 'code', ignored during the cooldown). */
  resend(): Promise<void>
  /** 'choose' → 'password'. */
  choosePassword(): void
  /** 'password' → 'choose' (not when a new password is required). */
  back(): void
  /** Goes straight in with the current password ('choose' or 'signedIn' → 'done'). */
  skip(): void
  /** Saves the new password ('password' → 'done'); resolves true once saved. */
  savePassword(password: string): Promise<boolean>
  /**
   * 'resuming' → 'signedIn' when this device is still signed in and no password is required;
   * otherwise this device is signed out ('ended').
   */
  resume(): Promise<void>
  /** 'ended' → 'code', sending a new code unless the last one is younger than the cooldown. */
  restart(): Promise<void>
}

interface VerifiedUser {
  email_confirmed_at?: string | null
  recovery_sent_at?: string | null
}

/**
 * True unless the address was confirmed before this recovery code was requested. Otherwise the
 * code is what confirmed it: the account's password (if any) was chosen by whoever signed up with
 * the address, so it must be replaced. Missing timestamps count as "confirmed by this code".
 */
export function codeConfirmedAddress(user: VerifiedUser | null | undefined): boolean {
  const confirmedAt = Date.parse(user?.email_confirmed_at ?? '')
  const sentAt = Date.parse(user?.recovery_sent_at ?? '')
  return !(confirmedAt < sentAt)
}

/**
 * The `session_id` claim of an access token (read only; Supabase Auth checks the signature when the
 * token is used). It stays the same when the session's tokens are refreshed.
 */
export function sessionIdOf(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null
  const payload = accessToken.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
    const id =
      typeof claims === 'object' && claims !== null
        ? (claims as { session_id?: unknown }).session_id
        : undefined
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

export function createPasswordReset({
  auth,
  email,
  codeUsed = false,
  passwordRequired = false,
  now = Date.now,
  sentAt = now(),
}: PasswordResetOptions): PasswordReset {
  const address = normalizeEmail(email)
  const store = createFlowStore(passwordResetReducer, {
    email: address,
    step: codeUsed ? 'resuming' : 'code',
    status: 'idle',
    passwordRequired,
    passwordChanged: false,
    error: null,
    notice: null,
    resendAvailableAt: resendAvailableAt(sentAt),
  })
  /** The session the code created; only it may set the new password. */
  let verified: { userId: string; sessionId: string } | null = null
  const fail = (error: FlowError<ResetField>) => {
    store.dispatch({ type: 'failed', error })
    return false
  }
  /** Signs this device out (the password is not changed) and ends the flow. */
  const end = async () => {
    verified = null
    await signOut(auth, 'local')
    store.dispatch({ type: 'sessionEnded' })
    return false
  }

  async function verify(input: string) {
    const token = normalizeCode(input)
    const state = store.getState()
    if (state.step !== 'code' || state.status !== 'idle') return false
    if (!isCompleteCode(token))
      return fail({ key: 'auth.validation.codeIncomplete', field: 'code' })
    if (!store.dispatch({ type: 'verify' })) return false
    const { data, error } = await auth.verifyOtp({ email: address, token, type: 'recovery' })
    if (error) {
      const key = authErrorKey(error)
      return fail({ key, field: key === 'auth.errors.codeInvalid' ? 'code' : undefined })
    }
    const userId = data.session?.user.id
    const sessionId = sessionIdOf(data.session?.access_token)
    verified = userId && sessionId ? { userId, sessionId } : null
    return store.dispatch({
      type: 'verified',
      passwordRequired: codeConfirmedAddress(data.user ?? data.session?.user),
    })
  }

  async function resend() {
    const state = store.getState()
    if (state.step !== 'code' || now() < state.resendAvailableAt) return
    if (!store.dispatch({ type: 'resend' })) return
    const { error } = await auth.resetPasswordForEmail(address)
    if (error && !isSilentError(error, 'recovery')) {
      fail({ key: authErrorKey(error) })
      return
    }
    store.dispatch({ type: 'resent', at: now() })
  }

  async function savePassword(password: string) {
    if (!store.dispatch({ type: 'save' })) return false
    const { data, error } = await auth.getSession()
    if (error && authErrorKey(error) !== 'errors.unauthorized') {
      return fail({ key: authErrorKey(error) })
    }
    // Only the session the code created: not after a sign-out, not a later sign-in (even of the
    // same user, e.g. from another tab), not another account. Tokens change on refresh; the
    // session id does not.
    const session = data.session
    if (
      !verified ||
      session?.user.id !== verified.userId ||
      sessionIdOf(session.access_token) !== verified.sessionId
    ) {
      return end()
    }
    const result = await auth.updateUser({ password })
    if (result.error) {
      const key = authErrorKey(result.error)
      if (key === 'errors.unauthorized') return end()
      return fail({ key, field: passwordErrorField(key, 'password') })
    }
    return store.dispatch({ type: 'saved' })
  }

  async function resume() {
    if (!store.dispatch({ type: 'resume' })) return
    // The code's session cannot be told apart from any other after a reload, so no password
    // change here (the account page asks for a new code, D-063).
    if (!store.getState().passwordRequired) {
      const { data } = await auth.getSession()
      if (data.session) {
        store.dispatch({ type: 'resumed' })
        return
      }
    }
    await end()
  }

  async function restart() {
    if (!store.dispatch({ type: 'restart' })) return
    await resend()
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    verify,
    resend,
    choosePassword: () => void store.dispatch({ type: 'choosePassword' }),
    back: () => void store.dispatch({ type: 'back' }),
    skip: () => void store.dispatch({ type: 'skip' }),
    savePassword,
    resume,
    restart,
  }
}
