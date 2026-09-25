import type { I18nKey } from '@bizcost/i18n'

// Supabase Auth errors → i18n keys, by `error.code` only (never the message text, which changes and
// may reveal whether an account exists). Anything unknown is `errors.internal` (docs/DECISIONS.md D-039).
// The one message read anywhere is the wait in the "too soon" answer, for its number only
// (email-retry.ts, D-073).

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

/**
 * `weak_password` reasons, in the order the Auth server checks them: shorter than
 * `minimum_password_length`, missing a `password_requirements` character set (here an ASCII letter or
 * digit, D-072), or found in a known data leak (leaked-password protection; checked only when the
 * others pass). The first reason picks the message: the same keys the new-password schema uses.
 */
const WEAK_PASSWORD_REASON_KEYS = {
  length: 'auth.validation.passwordTooShort',
  characters: 'auth.validation.passwordNeedsMix',
  pwned: 'auth.errors.passwordLeaked',
} as const satisfies Record<string, AuthMessageKey>

function weakPasswordKey(reasons: unknown): AuthMessageKey {
  const list: unknown[] = Array.isArray(reasons) ? reasons : []
  for (const [reason, key] of Object.entries(WEAK_PASSWORD_REASON_KEYS)) {
    if (list.includes(reason)) return key
  }
  return AUTH_ERROR_KEYS.weak_password
}

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
  if (code === 'weak_password') return weakPasswordKey(error.reasons)
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
 * success ("If you have an account, we sent a code"), so the screen never tells the two apart. After
 * `over_email_send_rate_limit` nothing was sent, so the code screen sends the request again once
 * (D-073).
 */
export const SILENT_ERROR_CODES = {
  /**
   * signUp: with SMS auto-confirm on (config.toml keeps it off, D-062), Supabase answers an existing
   * address with an error instead of a silent no-op. A rate limit is shown (D-062 (3)): mostly the
   * project-wide email budget. The per-address limit also answers a new address signed up again
   * within a minute (a confirmed one gets the silent no-op); `signUp` hides that answer when this
   * tab sent that sign-up code (D-073).
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

const PASSWORD_MESSAGES: ReadonlySet<AuthMessageKey> = new Set<AuthMessageKey>([
  ...Object.values(WEAK_PASSWORD_REASON_KEYS),
  'auth.errors.weakPassword',
  'auth.errors.samePassword',
  'auth.validation.passwordTooLong',
])

/** A message about the new password the user chose (it belongs under the password field). */
export function isPasswordMessage(key: AuthMessageKey): boolean {
  return PASSWORD_MESSAGES.has(key)
}

/**
 * Password messages go under the password field; everything else is for the whole form. On forms
 * whose only other input is a code, a `validation_failed` answer is about the password too.
 */
export function passwordErrorField<F extends string>(key: AuthMessageKey, field: F): F | undefined {
  return isPasswordMessage(key) || key === 'errors.validation' ? field : undefined
}
