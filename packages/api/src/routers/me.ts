import { meDto, type MeDto, type MembershipDto } from '@bizcost/contracts'
import { businesses, businessMembers, profiles, roles } from '@bizcost/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import { memoized, type Context } from '../context'
import { AppError } from '../errors'
import { ensureProfile, profileColumns, toProfileDto } from '../services/profile'
import { authedProcedure } from '../trpc'

/**
 * `me` (authed): the caller's profile and the businesses they can open.
 *
 * The profile is created here on first use (not by a trigger on auth.users): display name from the
 * email, locale from user_metadata.locale ('ar' when missing). An existing profile is never
 * overwritten, so repeated calls are idempotent.
 *
 * Memberships come from the own_memberships and member_businesses policies, so only businesses where
 * the caller is an active member are listed. Roles are tenant rows, readable only inside that
 * business's context: each membership's role is read in its own withTenantTx.
 *
 * Memoized per request: a batch that repeats `me` reads the database once.
 */
export const me = authedProcedure
  .output(meDto)
  .query(({ ctx }) => memoized(ctx, 'me', () => loadMe(ctx, ctx.auth)))

async function loadMe(ctx: Context, auth: AuthUser): Promise<MeDto> {
  const { userId, email } = auth

  const { profile, memberships } = await ctx.tenantTx(null, async (tx) => {
    // Create-if-missing keyed by the auth user id (not an idempotent client create).
    await ensureProfile(tx, auth)
    const [profile] = await tx.select(profileColumns).from(profiles).where(eq(profiles.id, userId))
    const memberships = await tx
      .select({
        businessId: businessMembers.businessId,
        legalName: businesses.legalName,
        status: businessMembers.status,
      })
      .from(businessMembers)
      .innerJoin(
        businesses,
        and(eq(businesses.id, businessMembers.businessId), isNull(businesses.deletedAt)),
      )
      .where(
        and(
          eq(businessMembers.userId, userId),
          eq(businessMembers.kind, 'account'),
          isNull(businessMembers.deletedAt),
        ),
      )
      .orderBy(asc(businessMembers.createdAt))
    return { profile, memberships }
  })
  if (!profile) throw new AppError('internal', { message: 'profile missing after upsert' })

  const withRoles: MembershipDto[] = []
  for (const membership of memberships) {
    const [member] = await ctx.tenantTx(membership.businessId, (tx) =>
      tx
        .select({ templateKey: roles.templateKey })
        .from(businessMembers)
        .leftJoin(
          roles,
          and(
            eq(roles.businessId, businessMembers.businessId),
            eq(roles.id, businessMembers.roleId),
            isNull(roles.deletedAt),
          ),
        )
        .where(
          and(
            eq(businessMembers.businessId, membership.businessId),
            eq(businessMembers.userId, userId),
            isNull(businessMembers.deletedAt),
          ),
        ),
    )
    // Removed between the two reads: leave it out.
    if (member) withRoles.push({ ...membership, roleTemplateKey: member.templateKey })
  }

  return {
    profile: toProfileDto(profile, email),
    memberships: withRoles,
  }
}
