import {
  AUTH_RECENT_SIGN_IN_SECONDS,
  DELETED_USER_DISPLAY_NAME,
  type DeleteAccountDto,
  type ProfileDto,
  type UpdateProfileInput,
} from '@bizcost/contracts'
import { businesses, businessMembers, profiles, roles, type Tx } from '@bizcost/db'
import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { assertAuthAdmin, authUserExists, deleteAuthUser } from '../admin/auth-admin'
import type { AuthUser } from '../auth'
import type { Context } from '../context'
import { AppError } from '../errors'
import { ensureProfile, profileColumns, toProfileDto } from './profile'

// The signed-in user's own account (docs/ARCHITECTURE.md §Auth): name and language, and deleting the
// account. Everything runs as the caller through ctx.tenantTx, under the identity-table policies.

/** Businesses where the caller is an active member (live businesses only). */
async function activeBusinessIds(ctx: Context, userId: string): Promise<string[]> {
  const rows = await ctx.tenantTx(null, (tx) =>
    tx
      .select({ businessId: businessMembers.businessId })
      .from(businessMembers)
      .innerJoin(
        businesses,
        and(eq(businesses.id, businessMembers.businessId), isNull(businesses.deletedAt)),
      )
      .where(
        and(
          eq(businessMembers.userId, userId),
          eq(businessMembers.kind, 'account'),
          eq(businessMembers.status, 'active'),
          isNull(businessMembers.deletedAt),
        ),
      ),
  )
  return rows.map((row) => row.businessId)
}

/**
 * Saves the caller's display name and/or language. A new name is also copied to the caller's active
 * memberships (business_members.display_name, the name co-members see, D-048), each in its business's
 * own transaction. A deleted (anonymized) profile is never changed: `unauthorized`.
 */
export async function updateProfile(
  ctx: Context,
  auth: AuthUser,
  input: UpdateProfileInput,
): Promise<ProfileDto> {
  const changes: { displayName?: string; locale?: string } = {}
  if (input.displayName !== undefined) changes.displayName = input.displayName
  if (input.locale !== undefined) changes.locale = input.locale
  const row = await ctx.tenantTx(null, async (tx) => {
    await ensureProfile(tx, auth)
    const [updated] = await tx
      .update(profiles)
      .set(changes)
      .where(and(eq(profiles.id, auth.userId), isNull(profiles.anonymizedAt)))
      .returning(profileColumns)
    return updated
  })
  if (!row) throw new AppError('unauthorized', { message: 'the account was deleted' })

  const { displayName } = changes
  if (displayName !== undefined) {
    for (const businessId of await activeBusinessIds(ctx, auth.userId)) {
      await ctx.tenantTx(businessId, (tx) =>
        tx
          .update(businessMembers)
          .set({ displayName })
          .where(
            and(
              eq(businessMembers.businessId, businessId),
              eq(businessMembers.userId, auth.userId),
              eq(businessMembers.kind, 'account'),
              isNull(businessMembers.deletedAt),
            ),
          ),
      )
    }
  }
  return toProfileDto(row, auth.email)
}

/** What deleting the account does to one business the caller is an active member of. */
type BusinessPlan =
  /** Another owner stays, or the caller is not an owner: only the membership is removed. */
  | { kind: 'leave'; memberId: string }
  /** The caller is its only member: the business is soft-deleted, then the membership removed. */
  | { kind: 'deleteBusiness'; memberId: string }
  /** The caller is its only owner and other people are members: deletion is refused. */
  | { kind: 'blocked' }
  /** No active membership any more (removed meanwhile). */
  | { kind: 'none' }

/**
 * Reads the members of the current business (tenant context = businessId) and decides. "Other
 * members" are every other member that is not removed (active, invited or suspended; with or without
 * an account): deleting the business would take it away from them, so the caller must first make one
 * of them an owner or remove them.
 */
async function planFor(tx: Tx, businessId: string, userId: string): Promise<BusinessPlan> {
  const members = await tx
    .select({
      id: businessMembers.id,
      userId: businessMembers.userId,
      kind: businessMembers.kind,
      status: businessMembers.status,
      templateKey: roles.templateKey,
    })
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
        eq(businessMembers.businessId, businessId),
        isNull(businessMembers.deletedAt),
        ne(businessMembers.status, 'removed'),
      ),
    )
  const activeOwner = (m: (typeof members)[number]) =>
    m.kind === 'account' && m.status === 'active' && m.templateKey === OWNER_TEMPLATE_KEY
  const mine = members.find(
    (m) => m.userId === userId && m.kind === 'account' && m.status === 'active',
  )
  if (!mine) return { kind: 'none' }
  const others = members.filter((m) => m.id !== mine.id)
  if (!activeOwner(mine) || others.some(activeOwner)) return { kind: 'leave', memberId: mine.id }
  return others.length === 0 ? { kind: 'deleteBusiness', memberId: mine.id } : { kind: 'blocked' }
}

/** Leaves one business, or soft-deletes it when the caller is its only member (its own transaction). */
async function leaveBusiness(ctx: Context, businessId: string, userId: string): Promise<boolean> {
  return ctx.tenantTx(businessId, async (tx) => {
    let plan = await planFor(tx, businessId, userId)
    if (plan.kind === 'deleteBusiness') {
      // Lock the business row, then decide again. Adding a member checks its foreign key to this
      // row (a KEY SHARE lock), so a member added meanwhile is either committed and seen now, or
      // waits until this deletion has committed.
      await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .for('update')
      plan = await planFor(tx, businessId, userId)
    }
    if (plan.kind === 'blocked') throw new AppError('sole_owner')
    if (plan.kind === 'none') return false
    if (plan.kind === 'deleteBusiness') {
      await tx
        .update(businesses)
        .set({ deletedAt: sql`now()` })
        .where(eq(businesses.id, businessId))
    }
    // Co-members no longer see the person's name (D-048).
    await tx
      .update(businessMembers)
      .set({ status: 'removed', displayName: DELETED_USER_DISPLAY_NAME })
      .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.id, plan.memberId)))
    return plan.kind === 'deleteBusiness'
  })
}

/**
 * Deletes the caller's account (docs/ARCHITECTURE.md §Auth, D-028, D-064):
 * 1. Checks, before any change: the secret key is set; the caller is not the only active owner of a
 *    business that has other members (`sole_owner`); the Auth admin API works (a wrong key or an
 *    outage is `internal`); the caller signed in or confirmed an emailed code within
 *    AUTH_RECENT_SIGN_IN_SECONDS (`reauth_required`).
 * 2. Per business, in that business's own transaction (the tenant context is one business): a
 *    business whose only member is the caller is soft-deleted (deleted_at); the caller's membership
 *    becomes `removed` and its display name 'Deleted user'. The database's owner rule still holds at
 *    every commit.
 * 3. In one transaction: the profile is anonymized (never deleted) and the auth user is deleted with
 *    the Admin API (its sessions end); a failed Admin call rolls the anonymization back.
 * Each step is idempotent, so a deletion that failed half-way (e.g. someone joined a business between
 * the check and step 2) can be retried by the still signed-in user.
 */
export async function deleteAccount(ctx: Context, auth: AuthUser): Promise<DeleteAccountDto> {
  const { userId } = auth
  assertAuthAdmin(ctx.config)
  const businessIds = await activeBusinessIds(ctx, userId)

  for (const businessId of businessIds) {
    const plan = await ctx.tenantTx(businessId, (tx) => planFor(tx, businessId, userId))
    if (plan.kind === 'blocked') throw new AppError('sole_owner')
  }

  // Once the auth user is gone (a retry after step 3 half failed), only the anonymization is left.
  if (await authUserExists(ctx.config, userId)) {
    const now = Math.floor(Date.now() / 1000)
    if (auth.authenticatedAt === null || now - auth.authenticatedAt > AUTH_RECENT_SIGN_IN_SECONDS) {
      throw new AppError('reauth_required')
    }
  }

  const deletedBusinessIds: string[] = []
  for (const businessId of businessIds) {
    if (await leaveBusiness(ctx, businessId, userId)) deletedBusinessIds.push(businessId)
  }

  await ctx.tenantTx(null, async (tx) => {
    await tx
      .insert(profiles)
      .values({
        id: userId,
        displayName: DELETED_USER_DISPLAY_NAME,
        locale: auth.locale ?? 'ar',
        lastBusinessId: null,
        anonymizedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          displayName: DELETED_USER_DISPLAY_NAME,
          lastBusinessId: null,
          anonymizedAt: sql`now()`,
        },
      })
    // Inside the transaction: if the Admin call fails, the profile stays as it was.
    await deleteAuthUser(ctx.config, userId)
  })
  return { deletedBusinessIds }
}
