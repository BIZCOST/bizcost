import type { I18nKey } from '@bizcost/i18n'

// Supabase Auth errors → i18n keys, by `error.code` only (never the message text, which changes and
// may reveal whether an account exists). Anything unknown is `errors.internal` (docs/DECISIONS.md D-039).

/** Message keys an auth flow can show. */
export type AuthMessageKey = Extract<
  I18nKey,
  `auth.errors.${string}` | `auth.validation.${string}` | `errors.${string}` | `account.${string}`
>

export const AUTH_ERROR_KEYS = {
  invalid_credentials: 'auth.errors.invalidCredentials',
  email_not_confirmed: 'auth.errors.emailNotConfirmed',
  otp_expired: 'auth.errors.codeInvalid',
  reauthentication_not_valid: 'auth.errors.codeInvalid',
  reauthentication_needed: 'auth.errors.reauthNeeded',
  reauth_nonce_missing: 'auth.errors.reauthNeeded',
  weak_password: 'auth.errors.weakPassword',
  same_password: 'auth.errors.samePassword',
  over_email_send_rate_limit: 'auth.errors.emailRateLimited',
  over_request_rate_limit: 'errors.rate_limited',
  signup_disabled: 'auth.errors.signupDisabled',
  email_address_invalid: 'auth.validation.emailInvalid',
  email_address_not_authorized: 'auth.errors.emailNotAuthorized',
  validation_failed: 'errors.validation',
  conflict: 'errors.conflict',
  request_timeout: 'errors.network',
  session_not_found: 'errors.unauthorized',
  session_expired: 'errors.unauthorized',
  refresh_token_not_found: 'errors.unauthorized',
  refresh_token_already_used: 'errors.unauthorized',
  bad_jwt: 'errors.unauthorized',
  no_authorization: 'errors.unauthorized',
} as const satisfies Record<string, AuthMessageKey>

/** `weak_password` reason: the password appears in a known data leak (leaked-password protection). */
const PWNED = 'pwned'

interface ErrorLike {
  code?: unknown
  name?: unknown
  status?: unknown
  reasons?: unknown
}

function isErrorLike(error: unknown): error is ErrorLike {
  return typeof error === 'object' && error !== null
}

/** The Supabase error code, if any. */
export function authErrorCode(error: unknown): string | undefined {
  return isErrorLike(error) && typeof error.code === 'string' ? error.code : undefined
}

/** The i18n key to show for a Supabase Auth error (or any other thrown value). */
export function authErrorKey(error: unknown): AuthMessageKey {
  if (!isErrorLike(error)) return 'errors.internal'
  const code = authErrorCode(error)
  if (code === 'weak_password' && Array.isArray(error.reasons) && error.reasons.includes(PWNED)) {
    return 'auth.errors.passwordLeaked'
  }
  if (code && Object.hasOwn(AUTH_ERROR_KEYS, code)) {
    return AUTH_ERROR_KEYS[code as keyof typeof AUTH_ERROR_KEYS]
  }
  // Network failures and 502/503/504 (supabase-js retries these itself first).
  if (error.name === 'AuthRetryableFetchError') return 'errors.network'
  if (error.name === 'AuthSessionMissingError') return 'errors.unauthorized'
  if (error.status === 429) return 'errors.rate_limited'
  return 'errors.internal'
}

/**
 * Errors that would reveal whether an email has an account, per request. Each is handled exactly like
 * success ("If you have an account, we sent a code"), so the screen never tells the two apart.
 */
export const SILENT_ERROR_CODES = {
  /**
   * signUp: with SMS auto-confirm on (config.toml keeps it off, D-062), Supabase answers an existing
   * address with an error instead of a silent no-op. A rate limit is shown: a new address can only
   * hit the project-wide email budget, which reveals nothing about accounts.
   */
  signUp: ['user_already_exists', 'email_exists'],
  /**
   * "Send me a code": the request creates missing accounts (D-062), so these only appear if sign-ups
   * are closed; the per-address rate limit would tell a recently used address apart.
   */
  signInCode: [
    'otp_disabled',
    'user_not_found',
    'signup_disabled',
    'email_not_confirmed',
    'over_email_send_rate_limit',
  ],
  /** resend({ type: 'signup' }) of a pending sign-up. */
  signUpResend: ['user_not_found', 'over_email_send_rate_limit'],
  /** resetPasswordForEmail. */
  recovery: ['user_not_found', 'email_not_confirmed', 'over_email_send_rate_limit'],
  /** updateUser({ email }) to an address another account uses. */
  emailChange: ['email_exists', 'user_already_exists'],
} as const satisfies Record<string, readonly string[]>

export function isSilentError(error: unknown, request: keyof typeof SILENT_ERROR_CODES): boolean {
  const code = authErrorCode(error)
  return code !== undefined && (SILENT_ERROR_CODES[request] as readonly string[]).includes(code)
}

export interface FlowError<F extends string> {
  key: AuthMessageKey
  /** The form field the message belongs to; none = a message for the whole form. */
  field?: F
}

/** Password messages go under the password field; everything else is for the whole form. */
export function passwordErrorField<F extends string>(key: AuthMessageKey, field: F): F | undefined {
  return key === 'auth.errors.weakPassword' ||
    key === 'auth.errors.passwordLeaked' ||
    key === 'auth.errors.samePassword' ||
    key === 'errors.validation'
    ? field
    : undefined
}
