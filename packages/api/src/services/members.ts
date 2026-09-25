import type { ChangeMemberRoleInput, MemberDto, MemberIdInput, OkDto } from '@bizcost/contracts'
import { businesses, businessMembers, rolePermissions, roles, type Tx } from '@bizcost/db'
import { newId, OWNER_TEMPLATE_KEY, type Locale } from '@bizcost/domain'
import { createI18n } from '@bizcost/i18n'
import { roleTemplateByKey } from '@bizcost/modules'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { revokeInvitationsBeyondSenders, revokeInvitationsSentBy } from './invitations'
import { assertRecentSignIn } from './reauth'
import { canGrant, isOwner } from './team-rules'

// Settings → Team, members (ROADMAP.md Step 6): list, change role, remove, transfer ownership. Only for
// a business with a team (capability has_team, checked by the router). The owner is changed only by a
// transfer; nobody hands out or takes away access beyond their own (team-rules.ts). Every change bumps
// the member's permissions_version, and a removed member is refused on their next request (their
// membership is read on every request). Pending invitations follow their sender: a member who leaves or
// is removed loses theirs, and after a role change those the sender could no longer send are revoked.

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
 * owner (OWNER_TRANSFER_REQUIRED) and the caller. A non-owner may only move members whose role and new
 * role grant nothing beyond their own permissions (FORBIDDEN).
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
    if (
      !canGrant(ctx.access, await roleKeys(tx, ctx.businessId, member.roleId)) ||
      !canGrant(ctx.access, await roleKeys(tx, ctx.businessId, role.id))
    ) {
      throw new AppError('forbidden', { message: 'cannot grant access beyond your own' })
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
 * non-owner may remove only members whose role grants nothing beyond their own permissions. Removing
 * yourself (not the owner) leaves the business.
 */
export async function removeMember(ctx: BusinessCtx, input: MemberIdInput): Promise<OkDto> {
  await ctx.tx(async (tx) => {
    const member = await lockMember(tx, ctx.businessId, input.memberId)
    if (member.roleTemplateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
    if (
      member.id !== ctx.access.memberId &&
      !canGrant(ctx.access, await roleKeys(tx, ctx.businessId, member.roleId))
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
