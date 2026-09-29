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
  /**
   * A location cannot be removed while some products or services are sold only there: they would be
   * sold everywhere (choose other locations for them first).
   */
  'only_location_of_products',
  /**
   * Another material, or another product or service, of the business already has this name (archived
   * ones included; names are compared ignoring case).
   */
  'name_taken',
  /** An uploaded file is missing, too large or not an allowed type (logo: PNG, JPEG or WebP, 2 MB). */
  'file_invalid',
  /** An attachment is missing, too large or not an allowed type (a photo or a PDF, 10 MB). */
  'attachment_invalid',
  /**
   * Posting or reversing something dated on or before the business's "books closed up to" date
   * (D-114 rule 6).
   */
  'books_closed',
  /** Posting a document dated after today (the business's time zone). */
  'future_date',
  /** Changing, discarding or posting again a document that is posted or reversed (D-036). */
  'document_posted',
  /** Reversing a draft, or a return or credit note for a purchase that is not posted (or reversed). */
  'document_not_posted',
  /** Reversing a purchase that has posted returns or credit notes: they are reversed first (D-120). */
  'purchase_has_returns',
  /**
   * Reversing a return or credit note while a later return of the same purchase line is posted: that
   * return is reversed first (D-142).
   */
  'has_later_returns',
  /** A return or credit note for more than is left of the purchase line (D-120). */
  'exceeds_purchase',
  /** Changing the kind of measure (dimension) of a material that purchases or recipes use. */
  'material_in_use',
  /**
   * Taking out or changing a pack or conversion of a material so that a recipe line in it no longer
   * converts to the material's base unit (the recipe is changed first).
   */
  'unit_in_use',
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
  /**
   * What the refusal is about, by name, only when the caller may see those records: UNIT_IN_USE names
   * the products whose recipes use the pack or conversion (at most 5). Absent otherwise.
   */
  names?: string[]
}
