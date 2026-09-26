import { LOCALES, MEMBER_STATUSES } from '@bizcost/domain'
import { z } from 'zod'
import { zUuid } from '../primitives'

export const localeDto = z.enum(LOCALES)

/** The signed-in user's own profile (`app.profiles`). */
export const profileDto = z.object({
  id: zUuid,
  displayName: z.string(),
  locale: localeDto,
  lastBusinessId: zUuid.nullable(),
})
export type ProfileDto = z.infer<typeof profileDto>

/**
 * One of the user's own memberships, for the business switcher. `me` lists active memberships only:
 * a business the user left or was removed from is no longer theirs to see.
 */
export const membershipDto = z.object({
  businessId: zUuid,
  legalName: z.string(),
  /** businesses.legal_name_ar; the Arabic app shows it instead of legalName (businessDisplayName). */
  legalNameAr: z.string().nullable(),
  /**
   * A signed URL of the business's logo, valid for at least half of LOGO_URL_TTL_SECONDS (a logo that
   * fails to load refetches `me`); null without a logo, beyond MEMBERSHIP_LOGOS_MAX, or when Storage
   * failed or did not answer in time.
   */
  logoUrl: z.string().nullable(),
  /** `roles.template_key`; null for a custom role. */
  roleTemplateKey: z.string().nullable(),
  status: z.enum(MEMBER_STATUSES),
})
export type MembershipDto = z.infer<typeof membershipDto>

/** `me` (authed). */
export const meDto = z.object({
  profile: profileDto,
  memberships: z.array(membershipDto),
})
export type MeDto = z.infer<typeof meDto>
