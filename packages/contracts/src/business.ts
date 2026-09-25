// Business limits shared by the API (dto/business-setup.ts) and the app forms. No Zod here, so a
// client that needs only the numbers does not bundle the API schemas.

/** Longest business name (businesses.legal_name from Smart Setup), in characters after trimming. */
export const BUSINESS_NAME_MAX_LENGTH = 100

/** Longest location (branch) name, in characters after trimming. */
export const LOCATION_NAME_MAX_LENGTH = 100

/** An invitation link works for this many days (a resend starts a new period with a new link). */
export const INVITATION_TTL_DAYS = 7

/** Invitations one business may send in 24 hours (counted in the database). */
export const INVITATION_DAILY_LIMIT = 20

/** Times one invitation may be sent again (send_count ≤ 1 + this, counted in the database). */
export const INVITATION_MAX_RESENDS = 3

/** Largest business logo (the bucket's file_size_limit), in bytes. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024

/** Image types a logo may have (the bucket's allowed_mime_types; never SVG). */
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number]

/** A signed logo URL in the business profile works for this many seconds. */
export const LOGO_URL_TTL_SECONDS = 600
