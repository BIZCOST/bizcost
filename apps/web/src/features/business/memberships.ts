import type { MembershipDto, MeDto } from '@bizcost/contracts'

/** The businesses the user can open: active memberships, oldest first (as `me` lists them). */
export function activeMemberships(me: MeDto): MembershipDto[] {
  return me.memberships.filter((m) => m.status === 'active')
}

/**
 * Where `/` sends a user who has businesses: the one opened last (profiles.last_business_id) while
 * it is still theirs, else the first one; null without any business (home shows Smart Setup).
 */
export function landingBusinessId(me: MeDto): string | null {
  const active = activeMemberships(me)
  const last = active.find((m) => m.businessId === me.profile.lastBusinessId)
  return (last ?? active[0])?.businessId ?? null
}
