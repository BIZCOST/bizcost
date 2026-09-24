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

/** One of the user's own memberships, for the business switcher. */
export const membershipDto = z.object({
  businessId: zUuid,
  legalName: z.string(),
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
