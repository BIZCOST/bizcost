// Typed API errors (docs/ARCHITECTURE.md §API & request flow). The server's error formatter puts the
// code and its i18n key on every error; clients translate the key and never show server text.

export const APP_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation',
  'module_disabled',
  'app_version_unsupported',
  'rate_limited',
  /** Account deletion: the caller is the only owner of a business that has other members. */
  'sole_owner',
  /**
   * Account deletion and ownership transfer: the caller must confirm it's them (a sign-in or an
   * emailed code) first.
   */
  'reauth_required',
  /** The business has the capability this needs switched off (e.g. team screens for a solo business). */
  'capability_disabled',
  /** An invitation link that is unknown, used, revoked or expired, or for another email. */
  'invitation_invalid',
  /** Accepting or inviting someone who is already an active member of the business. */
  'already_member',
  /** The email already has a pending invitation (resend it instead). */
  'already_invited',
  /** The team cannot be turned off while it has other members or pending invitations. */
  'team_in_use',
  /** More than one location cannot be turned off while the business has more than one location. */
  'locations_in_use',
  /** The owner cannot be removed or given another role, and no one is made owner, except by a transfer. */
  'owner_transfer_required',
  /** The default location cannot be removed (make another location the default first). */
  'default_location',
  /** An uploaded file is missing, too large or not an allowed type (logo: PNG, JPEG or WebP, 2 MB). */
  'file_invalid',
  'internal',
] as const
export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export type AppErrorI18nKey = `errors.${AppErrorCode}`

export function appErrorI18nKey<C extends AppErrorCode>(code: C): `errors.${C}` {
  return `errors.${code}`
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (APP_ERROR_CODES as readonly unknown[]).includes(value)
}

/** What the error formatter adds to `error.data`. */
export interface AppErrorData {
  appCode: AppErrorCode
  i18nKey: AppErrorI18nKey
}
