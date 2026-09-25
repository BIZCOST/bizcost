import type { Locale } from '@bizcost/domain'
import { normalizeEmail, type AuthClient } from './client'
import { authErrorCode, authErrorKey, isSilentError, type AuthMessageKey } from './errors'

// One-shot auth requests (docs/ARCHITECTURE.md §Auth). None of them tells the screen whether an
// account exists: the "request a code" steps succeed for any well-formed address.
// Sign-out (D-066): "Sign out" in the app header ends this device's session only ('local');
// "Sign out everywhere" on the account page ends every session ('global').

export type AuthOutcome<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: AuthMessageKey }

function failure(error: unknown): { ok: false; error: AuthMessageKey } {
  return { ok: false, error: authErrorKey(error) }
}

export interface SignUpInput {
  email: string
  password: string
  /** Saved as user_metadata.locale: the auth emails use it to pick the language. */
  locale: Locale
}

/**
 * Sign up → a 6-digit code is emailed (verify with a `signUp` code verification). An address that
 * already has an account gets the same answer and no email, so the code screen links to sign-in
 * and password reset.
 */
export async function signUp(
  auth: AuthClient,
  { email, password, locale }: SignUpInput,
): Promise<AuthOutcome<{ email: string }>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signUp({
    email: address,
    password,
    options: { data: { locale } },
  })
  if (error && !isSilentError(error, 'signUp')) return failure(error)
  return { ok: true, email: address }
}

export type SignInResult =
  | { next: 'signedIn' }
  /** The password was right but the email is not confirmed yet: a new sign-up code was sent. */
  | { next: 'confirmEmail'; email: string }

export async function signInWithPassword(
  auth: AuthClient,
  { email, password }: { email: string; password: string },
): Promise<AuthOutcome<SignInResult>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signInWithPassword({ email: address, password })
  if (!error) return { ok: true, next: 'signedIn' }
  if (authErrorCode(error) === 'email_not_confirmed') {
    // Only reachable with the right password, so this reveals nothing to a stranger.
    const resent = await auth.resend({ type: 'signup', email: address })
    if (resent.error && authErrorKey(resent.error) === 'errors.network')
      return failure(resent.error)
    return { ok: true, next: 'confirmEmail', email: address }
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
  { email, locale }: { email: string; locale: Locale },
): Promise<AuthOutcome<{ email: string }>> {
  const address = normalizeEmail(email)
  const { error } = await auth.signInWithOtp({
    email: address,
    // `data` is used only when the account is created: the auth emails' language.
    options: { shouldCreateUser: true, data: { locale } },
  })
  if (error && !isSilentError(error, 'signInCode')) return failure(error)
  return { ok: true, email: address }
}

/** "Forgot password": emails a recovery code if the address has an account. */
export async function requestPasswordReset(
  auth: AuthClient,
  { email }: { email: string },
): Promise<AuthOutcome<{ email: string }>> {
  const address = normalizeEmail(email)
  const { error } = await auth.resetPasswordForEmail(address)
  if (error && !isSilentError(error, 'recovery')) return failure(error)
  return { ok: true, email: address }
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
