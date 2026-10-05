import type {
  ChangeMemberRoleInput,
  MemberDto,
  MemberIdInput,
  MemberLocationsDto,
  MemberLocationsInput,
  MemberPermissionsDto,
  MemberPermissionsInput,
  OkDto,
  PermissionOverrideDto,
  UpdateMemberLocationsInput,
  UpdateMemberPermissionsInput,
} from '@bizcost/contracts'
import {
  businesses,
  businessMembers,
  memberLocations,
  memberPermissionOverrides,
  rolePermissions,
  roles,
  type Tx,
} from '@bizcost/db'
import {
  newId,
  OWNER_TEMPLATE_KEY,
  resolveEffective,
  type EffectivePermissions,
  type Locale,
  type PermissionEffect,
} from '@bizcost/domain'
import { createI18n } from '@bizcost/i18n'
import {
  isCatalogPermissionKey,
  keysMissingNeeds,
  PERMISSION_CATALOG,
  roleTemplateByKey,
  withNeededKeys,
} from '@bizcost/modules'
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { revokeInvitationsBeyondSenders, revokeInvitationsSentBy } from './invitations'
import { assertRecentSignIn } from './reauth'
import { uuidArray } from './stock'
import { canGrant, coversBranches, isOwner } from './team-rules'

// Settings → Team, members (ROADMAP.md Step 6): list, change role, remove, transfer ownership. Only for
// a business with a team (capability has_team, checked by the router). The owner is changed only by a
// transfer; nobody hands out or takes away access beyond their own (team-rules.ts). Every change bumps
// the member's permissions_version, and a removed member is refused on their next request (their
// membership is read on every request). Pending invitations follow their sender: a member who leaves or
// is removed loses theirs, and after a role change those the sender could no longer send are revoked.
//
// A member's own access (M2 Step 7, deferred from M1 by D-084): their changes to what their role
// grants (`member_permission_overrides`: a key added or taken away), read and saved whole. What a
// member may do is always their role's keys with their changes (resolveEffective), without a key that
// misses a key it needs (withNeededKeys); "beyond your own" compares that, not the role alone. The
// changes stay with the member when their role changes.

const memberColumns = {
  id: businessMembers.id,
  userId: businessMembers.userId,
  displayName: businessMembers.displayName,
  email: businessMembers.email,
  kind: businessMembers.kind,
  status: businessMembers.status,
  roleId: businessMembers.roleId,
  roleName: roles.name,
  roleTemplateKey: roles.templateKey,
  permissionsVersion: businessMembers.permissionsVersion,
  hasOverrides: sql<boolean>`exists (
    select 1 from app.member_permission_overrides o
     where o.business_id = ${businessMembers.businessId} and o.member_id = ${businessMembers.id}
       and o.deleted_at is null)`,
  createdAt: businessMembers.createdAt,
}

type MemberRow = {
  id: string
  userId: string | null
  displayName: string
  email: string | null
  kind: MemberDto['kind']
  status: MemberDto['status']
  roleId: string
  roleName: string | null
  roleTemplateKey: string | null
  permissionsVersion: number
  hasOverrides: boolean
  createdAt: Date
}

function toMemberDto(row: MemberRow, callerMemberId: string): MemberDto {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    kind: row.kind,
    status: row.status,
    roleId: row.roleId,
    roleName: row.roleName ?? '',
    roleTemplateKey: row.roleTemplateKey,
    isOwner: row.roleTemplateKey === OWNER_TEMPLATE_KEY,
    isYou: row.id === callerMemberId,
    // The owner's changes, if any were ever stored, count for nothing (resolveEffective).
    hasOverrides: row.roleTemplateKey !== OWNER_TEMPLATE_KEY && row.hasOverrides,
    joinedAt: row.createdAt.toISOString(),
  }
}

function membersQuery(tx: Tx) {
  return tx
    .select(memberColumns)
    .from(businessMembers)
    .leftJoin(
      roles,
      and(
        eq(roles.businessId, businessMembers.businessId),
        eq(roles.id, businessMembers.roleId),
        isNull(roles.deletedAt),
      ),
    )
}

/** A member of the business that is not removed; NOT_FOUND otherwise. Locked for the change. */
async function lockMember(tx: Tx, businessId: string, memberId: string): Promise<MemberRow> {
  const live = and(
    eq(businessMembers.businessId, businessId),
    eq(businessMembers.id, memberId),
    isNull(businessMembers.deletedAt),
    ne(businessMembers.status, 'removed'),
  )
  // Lock the membership alone (FOR UPDATE cannot name a schema-qualified table), then read it.
  const [locked] = await tx
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(live)
    .for('update')
  const [row] = locked ? await membersQuery(tx).where(live) : []
  if (!row) throw new AppError('not_found')
  return row
}

/** The permission keys a role grants (not for the Owner role, whose permissions are implicit). */
async function roleKeys(tx: Tx, businessId: string, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.businessId, businessId),
        eq(rolePermissions.roleId, roleId),
        isNull(rolePermissions.deletedAt),
      ),
    )
  return rows.map((row) => row.key)
}

/** The member's own changes to their role's access, by key. */
async function overridesOf(
  tx: Tx,
  businessId: string,
  memberId: string,
): Promise<PermissionOverrideDto[]> {
  const rows = await tx
    .select({
      key: memberPermissionOverrides.permissionKey,
      effect: memberPermissionOverrides.effect,
    })
    .from(memberPermissionOverrides)
    .where(
      and(
        eq(memberPermissionOverrides.businessId, businessId),
        eq(memberPermissionOverrides.memberId, memberId),
        isNull(memberPermissionOverrides.deletedAt),
      ),
    )
    .orderBy(asc(memberPermissionOverrides.permissionKey))
  return rows
}

/**
 * What a member with this role and these changes may do: the role's keys with the changes, without a
 * key that misses a key it needs (as loadBusinessAccess resolves it on their requests).
 */
function accessOf(
  roleTemplateKey: string | null,
  keys: readonly string[],
  overrides: readonly { key: string; effect: PermissionEffect }[],
): EffectivePermissions {
  return withNeededKeys(
    resolveEffective({
      roleTemplateKey,
      rolePermissionKeys: keys,
      overrides,
      catalog: PERMISSION_CATALOG,
    }),
  )
}

/** A member's access now: their role's keys (none for the Owner) and their changes to them. */
async function memberAccess(
  tx: Tx,
  businessId: string,
  member: Pick<MemberRow, 'id' | 'roleId' | 'roleTemplateKey'>,
  roleId: string = member.roleId,
  roleTemplateKey: string | null = member.roleTemplateKey,
): Promise<EffectivePermissions> {
  return accessOf(
    roleTemplateKey,
    await roleKeys(tx, businessId, roleId),
    await overridesOf(tx, businessId, member.id),
  )
}

/** `member.list` (settings.members.view): members that are not removed, owners first, then by name. */
export async function listMembers(ctx: BusinessCtx): Promise<MemberDto[]> {
  const rows = await ctx.tx((tx) =>
    membersQuery(tx)
      .where(
        and(
          eq(businessMembers.businessId, ctx.businessId),
          isNull(businessMembers.deletedAt),
          ne(businessMembers.status, 'removed'),
        ),
      )
      .orderBy(
        sql`(${roles.templateKey} is not distinct from ${OWNER_TEMPLATE_KEY}) desc`,
        asc(businessMembers.displayName),
        asc(businessMembers.id),
      ),
  )
  return rows.map((row) => toMemberDto(row, ctx.access.memberId))
}

/**
 * `member.changeRole` (settings.members.manage): any role except the Owner role, for anyone except the
 * owner (OWNER_TRANSFER_REQUIRED) and the caller. A non-owner may only move members whose access, now
 * and with the new role (their own changes stay with them), is nothing beyond their own, and a caller
 * limited to some branches only members limited within them (FORBIDDEN, D-236).
 */
export async function changeMemberRole(
  ctx: BusinessCtx,
  input: ChangeMemberRoleInput,
): Promise<MemberDto> {
  const row = await ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, input.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
    if (member.id === ctx.access.memberId) {
      throw new AppError('forbidden', { message: 'members cannot change their own role' })
    }
    const [role] = await tx
      .select({ id: roles.id, templateKey: roles.templateKey })
      .from(roles)
      .where(
        and(
          eq(roles.businessId, ctx.businessId),
          eq(roles.id, input.roleId),
          isNull(roles.deletedAt),
        ),
      )
    if (!role) throw new AppError('not_found')
    if (role.templateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
    // What they may do now and with the new role (their own changes stay with them).
    const now = await memberAccess(tx, ctx.businessId, member)
    const then = await memberAccess(tx, ctx.businessId, member, role.id, role.templateKey)
    if (!canGrant(ctx.access, now.keys) || !canGrant(ctx.access, then.keys)) {
      throw new AppError('forbidden', { message: 'cannot grant access beyond your own' })
    }
    // A caller limited to some branches moves only members limited within them (D-236).
    if (!coversBranches(ctx.access, await locationIdsOf(tx, ctx.businessId, member.id))) {
      throw new AppError('forbidden', { message: 'cannot change a member beyond your branches' })
    }
    if (member.roleId !== role.id) {
      await tx
        .update(businessMembers)
        .set({
          roleId: role.id,
          permissionsVersion: sql`${businessMembers.permissionsVersion} + 1`,
        })
        .where(
          and(eq(businessMembers.businessId, ctx.businessId), eq(businessMembers.id, member.id)),
        )
      await revokeInvitationsBeyondSenders(tx, ctx.businessId)
    }
    return lockMember(tx, ctx.businessId, member.id)
  })
  return toMemberDto(row, ctx.access.memberId)
}

/**
 * `member.remove` (settings.members.manage): the membership becomes `removed` (never deleted) and the
 * member is refused on their next request. The owner cannot be removed (OWNER_TRANSFER_REQUIRED); a
 * non-owner may remove only members whose access (their role and their own changes) is nothing beyond
 * their own, and a caller limited to some branches only members limited within them (D-236). Removing
 * yourself (not the owner) leaves the business.
 */
export async function removeMember(ctx: BusinessCtx, input: MemberIdInput): Promise<OkDto> {
  await ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, input.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
    if (
      member.id !== ctx.access.memberId &&
      (!canGrant(ctx.access, (await memberAccess(tx, ctx.businessId, member)).keys) ||
        !coversBranches(ctx.access, await locationIdsOf(tx, ctx.businessId, member.id)))
    ) {
      throw new AppError('forbidden', { message: 'cannot remove a member with more access' })
    }
    await markRemoved(tx, ctx.businessId, member)
  })
  return { ok: true }
}

/** The membership becomes `removed` (never deleted); the invitations its person sent stop working. */
async function markRemoved(tx: Tx, businessId: string, member: MemberRow): Promise<void> {
  // First, while the caller (who may be this member) is still active in the business.
  if (member.userId) await revokeInvitationsSentBy(tx, businessId, member.userId)
  await tx
    .update(businessMembers)
    .set({
      status: 'removed',
      permissionsVersion: sql`${businessMembers.permissionsVersion} + 1`,
    })
    .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.id, member.id)))
}

/**
 * `member.leave` (any member but the owner): the caller leaves the business, like being removed. The
 * owner transfers ownership first (OWNER_TRANSFER_REQUIRED).
 */
export async function leaveBusiness(ctx: BusinessCtx): Promise<OkDto> {
  await ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, ctx.access.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
    await markRemoved(tx, ctx.businessId, member)
  })
  return { ok: true }
}

/** The business's Admin role; created from the template when it was deleted. */
async function adminRoleId(tx: Tx, businessId: string): Promise<string> {
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.businessId, businessId),
        eq(roles.templateKey, 'admin'),
        isNull(roles.deletedAt),
      ),
    )
    .orderBy(asc(roles.createdAt))
    .limit(1)
  if (role) return role.id
  const [business] = await tx
    .select({ locale: businesses.defaultLocale })
    .from(businesses)
    .where(eq(businesses.id, businessId))
  const locale: Locale = business?.locale === 'en' ? 'en' : 'ar'
  const template = roleTemplateByKey('admin')
  const id = newId()
  await tx.insert(roles).values({
    id,
    businessId,
    name: createI18n({ locale, namespaces: [] }).t('common.roles.admin'),
    templateKey: 'admin',
  })
  if (template && template.permissionKeys.length > 0) {
    await tx.insert(rolePermissions).values(
      template.permissionKeys.map((permissionKey) => ({
        id: newId(),
        businessId,
        roleId: id,
        permissionKey,
      })),
    )
  }
  return id
}

/**
 * `member.transferOwnership` (the owner only): the member (an active account member other than the
 * caller) gets the Owner role and the caller becomes Admin, in one transaction (the database's owner
 * rule holds at commit). Needs a sign-in or an emailed code within AUTH_RECENT_SIGN_IN_SECONDS
 * (REAUTH_REQUIRED), like account deletion.
 */
export async function transferOwnership(ctx: BusinessCtx, input: MemberIdInput): Promise<OkDto> {
  if (!isOwner(ctx.access)) throw new AppError('forbidden', { message: 'only the owner transfers' })
  assertRecentSignIn(ctx.auth)
  await ctx.tx(async (tx) => {
    const caller = await lockMember(tx, ctx.businessId, ctx.access.memberId)
    if (caller.roleTemplateKey !== OWNER_TEMPLATE_KEY || caller.status !== 'active') {
      throw new AppError('forbidden', { message: 'only the owner transfers' })
    }
    const target = await lockMember(tx, ctx.businessId, input.memberId)
    if (target.id === caller.id) throw new AppError('validation', { message: 'already the owner' })
    if (target.kind !== 'account' || target.status !== 'active') {
      throw new AppError('validation', { message: 'the new owner must be an active member' })
    }
    const adminId = await adminRoleId(tx, ctx.businessId)
    await tx
      .update(businessMembers)
      .set({
        roleId: caller.roleId,
        permissionsVersion: sql`${businessMembers.permissionsVersion} + 1`,
      })
      .where(and(eq(businessMembers.businessId, ctx.businessId), eq(businessMembers.id, target.id)))
    await tx
      .update(businessMembers)
      .set({
        roleId: adminId,
        permissionsVersion: sql`${businessMembers.permissionsVersion} + 1`,
      })
      .where(and(eq(businessMembers.businessId, ctx.businessId), eq(businessMembers.id, caller.id)))
    // The former owner is an Admin now: invitations beyond the Admin role stop working.
    await revokeInvitationsBeyondSenders(tx, ctx.businessId)
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------
// A member's own access (M2 Step 7; D-084 deferred it to the first module with sensitive fields)
// ---------------------------------------------------------------------------------------------------

const byKey = (a: { key: string }, b: { key: string }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0

function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].sort()
}

/** The member's access as `member.permissions` returns it. */
async function memberPermissionsOf(
  tx: Tx,
  ctx: BusinessCtx,
  member: MemberRow,
): Promise<MemberPermissionsDto> {
  const owner = member.roleTemplateKey === OWNER_TEMPLATE_KEY
  const keys = owner ? [] : await roleKeys(tx, ctx.businessId, member.roleId)
  const overrides = owner ? [] : await overridesOf(tx, ctx.businessId, member.id)
  const effective = accessOf(member.roleTemplateKey, keys, overrides)
  const isYou = member.id === ctx.access.memberId
  return {
    memberId: member.id,
    displayName: member.displayName,
    roleId: member.roleId,
    roleName: member.roleName ?? '',
    roleTemplateKey: member.roleTemplateKey,
    isOwner: owner,
    isYou,
    roleKeys: sortedKeys(keys.filter(isCatalogPermissionKey)),
    overrides: overrides.filter((o) => isCatalogPermissionKey(o.key)),
    effectiveKeys: sortedKeys(effective.keys),
    editable:
      !owner &&
      !isYou &&
      canGrant(ctx.access, effective.keys) &&
      coversBranches(ctx.access, owner ? [] : await locationIdsOf(tx, ctx.businessId, member.id)),
    version: member.permissionsVersion,
  }
}

/**
 * `member.permissions` (settings.members.view and settings.roles.manage): what a member (not removed;
 * NOT_FOUND otherwise) may do, from their role and their own changes to it, and whether the caller may
 * change it.
 */
export function getMemberPermissions(
  ctx: BusinessCtx,
  input: MemberPermissionsInput,
): Promise<MemberPermissionsDto> {
  return ctx.tx(async (tx) => {
    const live = and(
      eq(businessMembers.businessId, ctx.businessId),
      eq(businessMembers.id, input.memberId),
      isNull(businessMembers.deletedAt),
      ne(businessMembers.status, 'removed'),
    )
    const [member] = await membersQuery(tx).where(live)
    if (!member) throw new AppError('not_found')
    return memberPermissionsOf(tx, ctx, member)
  })
}

/**
 * The changes worth keeping: a key the role grants anyway is not "added", and one it does not grant is
 * not "taken away" (the list says only how the member differs from their role).
 */
function differences(
  wanted: readonly { key: string; effect: PermissionEffect }[],
  roleGrants: ReadonlySet<string>,
): PermissionOverrideDto[] {
  return wanted
    .filter((o) => (o.effect === 'allow') !== roleGrants.has(o.key))
    .map((o) => ({ key: o.key, effect: o.effect }))
    .sort(byKey)
}

/**
 * `member.updatePermissions` (settings.members.view and settings.roles.manage): replaces the member's
 * own changes to their role's access (an empty list clears them), `version` as read (the member's
 * permissions version: CONFLICT when their access moved on since). Keys from the permission catalog,
 * once each (VALIDATION); a change the role already says (allowing a key it grants, taking away one it
 * does not) is dropped. What the member may then do must hold every key each of its keys needs
 * (PERMISSION_NEEDS: costs, supplier prices and margins only together; VALIDATION). Not the owner
 * (VALIDATION: they have every permission) and not the caller's own access (FORBIDDEN). "No access
 * beyond your own": a caller who is not the owner changes only a member who may do nothing beyond the
 * caller (nor, for a caller limited to some branches, one who works beyond them: D-236), only keys the
 * caller holds, and leaves them nothing beyond the caller (FORBIDDEN). Saving
 * bumps the member's permissions version (their apps reload their access) and revokes the pending
 * invitations they could no longer send.
 */
export function updateMemberPermissions(
  ctx: BusinessCtx,
  input: UpdateMemberPermissionsInput,
): Promise<MemberPermissionsDto> {
  const unknown = input.overrides.filter((o) => !isCatalogPermissionKey(o.key)).map((o) => o.key)
  if (unknown.length > 0) {
    throw new AppError('validation', { message: `unknown permission keys: ${unknown.join(', ')}` })
  }
  const seen = new Set<string>()
  for (const { key } of input.overrides) {
    if (seen.has(key)) throw new AppError('validation', { message: `${key} given twice` })
    seen.add(key)
  }
  return ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, input.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) {
      throw new AppError('validation', { message: 'the owner has every permission' })
    }
    if (member.id === ctx.access.memberId) {
      throw new AppError('forbidden', { message: 'members cannot change their own access' })
    }
    if (member.permissionsVersion !== input.version) throw new AppError('conflict')

    const keys = await roleKeys(tx, ctx.businessId, member.roleId)
    const current = await overridesOf(tx, ctx.businessId, member.id)
    const before = accessOf(member.roleTemplateKey, keys, current)
    // A member with more access than the caller's is left alone.
    if (
      !canGrant(ctx.access, before.keys) ||
      !coversBranches(ctx.access, await locationIdsOf(tx, ctx.businessId, member.id))
    ) {
      throw new AppError('forbidden', { message: 'cannot change a member with more access' })
    }
    const wanted = differences(input.overrides, new Set(keys))
    const effectOf = (list: readonly PermissionOverrideDto[]) =>
      new Map(list.map((o) => [o.key, o.effect] as const))
    const was = effectOf(current)
    const will = effectOf(wanted)
    const changed = [...new Set([...was.keys(), ...will.keys()])].filter(
      (key) => was.get(key) !== will.get(key),
    )
    const after = resolveEffective({
      roleTemplateKey: member.roleTemplateKey,
      rolePermissionKeys: keys,
      overrides: wanted,
      catalog: PERMISSION_CATALOG,
    })
    if (!canGrant(ctx.access, changed) || !canGrant(ctx.access, after.keys)) {
      throw new AppError('forbidden', { message: 'cannot change permissions you do not have' })
    }
    const incomplete = keysMissingNeeds(after.keys)
    if (incomplete.length > 0) {
      throw new AppError('validation', {
        message: `keys without the permission they need: ${incomplete.join(', ')}`,
      })
    }

    if (changed.length > 0) {
      const removed = changed.filter((key) => !will.has(key))
      if (removed.length > 0) {
        await tx
          .update(memberPermissionOverrides)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(memberPermissionOverrides.businessId, ctx.businessId),
              eq(memberPermissionOverrides.memberId, member.id),
              inArray(memberPermissionOverrides.permissionKey, removed),
              isNull(memberPermissionOverrides.deletedAt),
            ),
          )
      }
      for (const override of wanted.filter((o) => changed.includes(o.key))) {
        await tx
          .insert(memberPermissionOverrides)
          .values({
            id: newId(),
            businessId: ctx.businessId,
            memberId: member.id,
            permissionKey: override.key,
            effect: override.effect,
          })
          .onConflictDoUpdate({
            target: [
              memberPermissionOverrides.businessId,
              memberPermissionOverrides.memberId,
              memberPermissionOverrides.permissionKey,
            ],
            set: { effect: override.effect, deletedAt: null },
          })
      }
      await tx
        .update(businessMembers)
        .set({ permissionsVersion: sql`${businessMembers.permissionsVersion} + 1` })
        .where(
          and(eq(businessMembers.businessId, ctx.businessId), eq(businessMembers.id, member.id)),
        )
      await revokeInvitationsBeyondSenders(tx, ctx.businessId)
    }
    return memberPermissionsOf(tx, ctx, await lockMember(tx, ctx.businessId, member.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// A member's branches (M3 Step 2, Q12; D-054, D-191)
// ---------------------------------------------------------------------------------------------------

/** The live member_locations of a member (empty: every branch, D-054), sorted. */
async function locationIdsOf(tx: Tx, businessId: string, memberId: string): Promise<string[]> {
  const rows = await tx
    .select({ locationId: memberLocations.locationId })
    .from(memberLocations)
    .where(
      and(
        eq(memberLocations.businessId, businessId),
        eq(memberLocations.memberId, memberId),
        isNull(memberLocations.deletedAt),
      ),
    )
  return rows.map((row) => row.locationId).sort()
}

async function memberLocationsOf(
  tx: Tx,
  ctx: BusinessCtx,
  member: MemberRow,
): Promise<MemberLocationsDto> {
  const owner = member.roleTemplateKey === OWNER_TEMPLATE_KEY
  const isYou = member.id === ctx.access.memberId
  const ids = owner ? [] : await locationIdsOf(tx, ctx.businessId, member.id)
  const access = owner ? null : await memberAccess(tx, ctx.businessId, member)
  return {
    memberId: member.id,
    locationIds: ids,
    editable:
      !owner &&
      !isYou &&
      access !== null &&
      canGrant(ctx.access, access.keys) &&
      coversBranches(ctx.access, ids),
    version: member.permissionsVersion,
  }
}

/**
 * `member.locations` ("Branches they work in", Q12; module sales, a team and branches): the branches
 * a member (not removed; NOT_FOUND otherwise) works in, empty for all of them (the Owner always), and
 * whether the caller may change it.
 */
export function getMemberLocations(
  ctx: BusinessCtx,
  input: MemberLocationsInput,
): Promise<MemberLocationsDto> {
  return ctx.tx(async (tx) => {
    const [member] = await membersQuery(tx).where(
      and(
        eq(businessMembers.businessId, ctx.businessId),
        eq(businessMembers.id, input.memberId),
        isNull(businessMembers.deletedAt),
        ne(businessMembers.status, 'removed'),
      ),
    )
    if (!member) throw new AppError('not_found')
    return memberLocationsOf(tx, ctx, member)
  })
}

/**
 * `member.updateLocations`: the branches a member works in, all of them (empty: every branch, those
 * added later included), `version` as read (the member's permissions version: CONFLICT when their
 * access moved on). Each a live location of the business (NOT_FOUND). Not the Owner (VALIDATION: they
 * work everywhere) and not one's own (FORBIDDEN). "No access beyond your own": a caller who is not the
 * owner changes only a member who may do nothing beyond the caller, and a caller limited to some
 * branches only a member limited within them, and only to some of theirs (FORBIDDEN). Saving bumps the
 * member's permissions version (their apps reload their access) and revokes the pending invitations
 * they sent beyond their branches now (D-236); a member limited to a branch sees and enters only its
 * sales (Q12).
 */
export function updateMemberLocations(
  ctx: BusinessCtx,
  input: UpdateMemberLocationsInput,
): Promise<MemberLocationsDto> {
  return ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, input.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) {
      throw new AppError('validation', { message: 'the owner works in every branch' })
    }
    if (member.id === ctx.access.memberId) {
      throw new AppError('forbidden', { message: 'members cannot change their own branches' })
    }
    // The branches named first (a reference of another business is NOT_FOUND whatever the version).
    const wanted = [...new Set(input.locationIds.map((id) => id.toLowerCase()))].sort()
    if (wanted.length > 0) {
      const found = await tx.execute(sql`
        select l.id from app.locations l
         where l.business_id = ${ctx.businessId} and l.deleted_at is null
           and l.id = any(${uuidArray(wanted)})
      `)
      if ((found as unknown as unknown[]).length !== wanted.length) {
        throw new AppError('not_found')
      }
    }
    if (member.permissionsVersion !== input.version) throw new AppError('conflict')
    const current = await locationIdsOf(tx, ctx.businessId, member.id)
    const access = await memberAccess(tx, ctx.businessId, member)
    if (
      !canGrant(ctx.access, access.keys) ||
      !coversBranches(ctx.access, current) ||
      !coversBranches(ctx.access, wanted)
    ) {
      throw new AppError('forbidden', { message: 'cannot give branches beyond your own' })
    }
    const removed = current.filter((id) => !wanted.includes(id))
    const added = wanted.filter((id) => !current.includes(id))
    if (removed.length > 0 || added.length > 0) {
      if (removed.length > 0) {
        await tx
          .update(memberLocations)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(memberLocations.businessId, ctx.businessId),
              eq(memberLocations.memberId, member.id),
              inArray(memberLocations.locationId, removed),
              isNull(memberLocations.deletedAt),
            ),
          )
      }
      for (const locationId of added) {
        await tx
          .insert(memberLocations)
          .values({ id: newId(), businessId: ctx.businessId, memberId: member.id, locationId })
          .onConflictDoUpdate({
            target: [
              memberLocations.businessId,
              memberLocations.memberId,
              memberLocations.locationId,
            ],
            set: { deletedAt: null },
          })
      }
      await tx
        .update(businessMembers)
        .set({ permissionsVersion: sql`${businessMembers.permissionsVersion} + 1` })
        .where(
          and(eq(businessMembers.businessId, ctx.businessId), eq(businessMembers.id, member.id)),
        )
      // The invitations they sent that reach beyond their branches now stop working (D-236).
      await revokeInvitationsBeyondSenders(tx, ctx.businessId)
    }
    return memberLocationsOf(tx, ctx, await lockMember(tx, ctx.businessId, member.id))
  })
}
