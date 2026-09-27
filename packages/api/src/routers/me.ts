import { meDto, type MeDto, type MembershipDto } from '@bizcost/contracts'
import { businesses, businessMembers, profiles, roles } from '@bizcost/db'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import { memoized, type Context } from '../context'
import { AppError } from '../errors'
import { membershipLogoUrls } from '../services/business-profile'
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
 * business's context: each membership's role is read in its own withTenantTx. That transaction also
 * copies the account's verified email to the membership when it changed (business_members.email, which
 * co-members see and invitations are checked against), the way a new name is copied (D-048). That copy
 * makes `me` the one query that writes audited business rows (D-103): it writes only the token's own
 * email, so a cross-site GET can set nothing else.
 *
 * Each active membership has the business's Arabic name and a signed URL of its logo (D-097): one
 * Storage request for all of them, at most MEMBERSHIP_LOGOS_MAX (the business opened last, then the
 * oldest), made while the roles are read. When Storage fails or is slow (SIGNING_TIMEOUT_MS), `me`
 * answers without logos and does not ask Storage again for a while (membershipLogoUrls).
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
        legalNameAr: businesses.legalNameAr,
        logoPath: businesses.logoPath,
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

  // Signed while the roles are read; a business left out below gets no URL. Never rejects.
  const logos = logoUrls(ctx, memberships, profile.lastBusinessId)

  const withRoles: (Omit<MembershipDto, 'logoUrl'> & { logoPath: string | null })[] = []
  for (const membership of memberships) {
    const [member] = await ctx.tenantTx(membership.businessId, async (tx) => {
      if (email) {
        await tx
          .update(businessMembers)
          .set({ email })
          .where(
            and(
              eq(businessMembers.businessId, membership.businessId),
              eq(businessMembers.userId, userId),
              eq(businessMembers.kind, 'account'),
              isNull(businessMembers.deletedAt),
              sql`${businessMembers.email} is distinct from ${email}::citext`,
            ),
          )
      }
      return tx
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
        )
    })
    // Removed between the two reads: leave it out.
    if (member) withRoles.push({ ...membership, roleTemplateKey: member.templateKey })
  }

  const logoOf = await logos
  return {
    profile: toProfileDto(profile, email),
    memberships: withRoles.map((membership) => {
      const active = membership.status === 'active'
      return {
        businessId: membership.businessId,
        legalName: membership.legalName,
        legalNameAr: active ? membership.legalNameAr : null,
        logoUrl: active ? (logoOf.get(membership.businessId) ?? null) : null,
        roleTemplateKey: membership.roleTemplateKey,
        status: membership.status,
      }
    }),
  }
}

/** The active memberships' logos, the business opened last first; none when Storage fails. */
function logoUrls(
  ctx: Context,
  memberships: readonly { businessId: string; status: string; logoPath: string | null }[],
  lastBusinessId: string | null,
): Promise<Map<string, string>> {
  const logos = memberships
    .flatMap(({ businessId, status, logoPath }) =>
      status === 'active' && logoPath ? [{ businessId, logoPath }] : [],
    )
    .sort(
      (a, b) => Number(b.businessId === lastBusinessId) - Number(a.businessId === lastBusinessId),
    )
  // Without logos the switcher shows the store mark; the app goes on.
  return membershipLogoUrls(ctx.config, logos, ctx.reportError)
}
