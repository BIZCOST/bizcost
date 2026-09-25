import type { Locale } from '@bizcost/domain'
import { normalizeEmail, type AuthClient } from './client'
import { emailRetryAt, sentRecently, type SentCode } from './email-retry'
import { authErrorCode, authErrorKey, isSilentError, type AuthMessageKey } from './errors'

// One-shot auth requests (docs/ARCHITECTURE.md §Auth). None of them tells the screen whether an
// account exists: the "request a code" steps succeed for any well-formed address.
// Sign-out (D-066): "Sign out" in the app header ends this device's session only ('local');
// "Sign out everywhere" on the account page ends every session ('global').
// A code request answered "too soon" also returns `retryAt`: the code screen sends it again once
// then (D-073), unless `sent` shows this tab asked for the same code less than a cooldown ago.

export type AuthOutcome<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: AuthMessageKey }

function failure(error: unknown): { ok: false; error: AuthMessageKey } {
  return { ok: false, error: authErrorKey(error) }
}

/** A code request that went through (or looks like it did). */
export interface CodeRequest {
  email: string
  /**
   * The server answered "too soon" (`over_email_send_rate_limit`), so no email was sent: epoch ms
   * when the code screen sends the request again, once (D-073).
   */
  retryAt?: number
}

/**
 * The code request's answer for the screen. "Too soon" plans the one automatic resend, except when
 * `sent` (the code this tab last asked for with the same request) went to this address less than a
 * cooldown ago: that email is the one inside the window and its code still works (D-073).
 */
function requested(email: string, error: unknown, sent?: SentCode | null): CodeRequest {
  const now = Date.now()
  const retryAt = emailRetryAt(error, now)
  return retryAt === null || sentRecently(sent, email, now) ? { email } : { email, retryAt }
}

/**
 * The code this tab last asked for with the same request (D-073): the sign-up code for `signUp` and
 * a password sign-in of an unconfirmed email, the sign-in code for `requestSignInCode`, the reset
 * code for `requestPasswordReset`. None or another address: a "too soon" answer is retried.
 */
interface EarlierCode {
  sent?: SentCode | null
}

export interface SignUpInput extends EarlierCode {
  email: string
  password: string
  /** Saved as user_metadata.locale: the auth emails use it to pick the language. */
  locale: Locale
}

/**
 * Sign up → a 6-digit code is emailed (verify with a `signUp` code verification). An address that
 * already has an account gets the same answer and no email, so the code screen tells everyone that a
 * registered address gets no code (D-073).
 */
export async function signUp(
  auth: AuthClient,
  { email, password, locale, sent }: SignUpInput,
): Promise<AuthOutcome<{ email: string }>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signUp({
    email: address,
    password,
    options: { data: { locale } },
  })
  // Signed up again within a minute: only a new address is answered "too soon" (a registered one
  // gets the silent no-op). After this tab's own sign-up code to it, that code still works, so this
  // looks like the first sign-up (D-073); any other rate limit is shown (D-062 (3)).
  const repeated =
    authErrorCode(error) === 'over_email_send_rate_limit' && sentRecently(sent, address, Date.now())
  if (error && !repeated && !isSilentError(error, 'signUp')) return failure(error)
  return { ok: true, email: address }
}

export type SignInResult =
  | { next: 'signedIn' }
  /** The password was right but the email is not confirmed yet: a new sign-up code was sent. */
  | ({ next: 'confirmEmail' } & CodeRequest)

export async function signInWithPassword(
  auth: AuthClient,
  { email, password, sent }: { email: string; password: string } & EarlierCode,
): Promise<AuthOutcome<SignInResult>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signInWithPassword({ email: address, password })
  if (!error) return { ok: true, next: 'signedIn' }
  if (authErrorCode(error) === 'email_not_confirmed') {
    // Only reachable with the right password, so this reveals nothing to a stranger.
    const resent = await auth.resend({ type: 'signup', email: address })
    if (resent.error && authErrorKey(resent.error) === 'errors.network')
      return failure(resent.error)
    return { ok: true, next: 'confirmEmail', ...requested(address, resent.error, sent) }
  }
  return failure(error)
}

/**
 * "Send me a code" (D-062): emails a code to any address. An address without an account gets one
 * (not confirmed until the code is entered; the email is then the sign-up code), so Supabase Auth
 * answers a registered and a new address the same way. Verify with a `signIn` code verification.
 */
export async function requestSignInCode(
  auth: AuthClient,
  { email, locale, sent }: { email: string; locale: Locale } & EarlierCode,
): Promise<AuthOutcome<CodeRequest>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signInWithOtp({
    email: address,
    // `data` is used only when the account is created: the auth emails' language.
    options: { shouldCreateUser: true, data: { locale } },
  })
  if (error && !isSilentError(error, 'signInCode')) return failure(error)
  return { ok: true, ...requested(address, error, sent) }
}

/** "Forgot password": emails a recovery code if the address has an account. */
export async function requestPasswordReset(
  auth: AuthClient,
  { email, sent }: { email: string } & EarlierCode,
): Promise<AuthOutcome<CodeRequest>> {
  const address = normalizeEmail(email)
  const { error } = await auth.resetPasswordForEmail(address)
  if (error && !isSilentError(error, 'recovery')) return failure(error)
  return { ok: true, ...requested(address, error, sent) }
}

/**
 * Sign out. `local` ends this device's session (the header's "Sign out", and after the account was
 * deleted); `global` ("Sign out everywhere") revokes every session of the user. A session that is
 * already gone counts as signed out.
 */
export async function signOut(auth: AuthClient, scope: 'global' | 'local'): Promise<AuthOutcome> {
  const { error } = await auth.signOut({ scope })
  if (error && authErrorKey(error) !== 'errors.unauthorized') return failure(error)
  return { ok: true }
}

/**
 * Keeps user_metadata.locale (read by the auth email templates) in step with the chosen language.
 * The app also saves `profiles.locale` through the API.
 */
export async function syncAuthLocale(auth: AuthClient, locale: Locale): Promise<AuthOutcome> {
  const { error } = await auth.updateUser({ data: { locale } })
  return error ? failure(error) : { ok: true }
}
