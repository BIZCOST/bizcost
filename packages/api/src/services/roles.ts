import type { RoleDto, UpdateRolePermissionsInput } from '@bizcost/contracts'
import { businessMembers, rolePermissions, roles, type Tx } from '@bizcost/db'
import { newId, OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import { isCatalogPermissionKey, keysMissingNeeds, ROLE_TEMPLATE_KEYS } from '@bizcost/modules'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { revokeInvitationsBeyondSenders } from './invitations'
import { canGrant } from './team-rules'

// Settings → Roles (ROADMAP.md Step 6): the business's roles (template copies from Smart Setup) and
// editing which permissions a role grants. The Owner role is read-only (every permission, implicitly).
// No custom roles and no per-member overrides in M1. Saving bumps permissions_version for every member
// with the role, so their apps refetch their access, and revokes the pending invitations that their
// senders could no longer send.

type RoleRow = {
  id: string
  name: string
  templateKey: string | null
  version: number
  keys: string[] | null
  members: number
}

async function roleRows(tx: Tx, businessId: string, roleId?: string): Promise<RoleRow[]> {
  const rows = await tx.execute<RoleRow>(sql`
    select r.id, r.name, r.template_key as "templateKey", r.version,
      (select array_agg(rp.permission_key order by rp.permission_key)
         from ${rolePermissions} rp
        where rp.business_id = r.business_id and rp.role_id = r.id and rp.deleted_at is null) as keys,
      (select count(*)::int
         from ${businessMembers} m
        where m.business_id = r.business_id and m.role_id = r.id and m.deleted_at is null
          and m.status in ('active', 'suspended')) as members
    from ${roles} r
    where r.business_id = ${businessId} and r.deleted_at is null
      ${roleId === undefined ? sql`` : sql`and r.id = ${roleId}`}
  `)
  return [...rows]
}

const TEMPLATE_RANK = new Map<string, number>(ROLE_TEMPLATE_KEYS.map((key, i) => [key, i]))

function toRoleDto(row: RoleRow): RoleDto {
  const isOwnerRole = row.templateKey === OWNER_TEMPLATE_KEY
  return {
    id: row.id,
    name: row.name,
    templateKey: row.templateKey,
    isOwner: isOwnerRole,
    permissionKeys: isOwnerRole ? [] : (row.keys ?? []).filter(isCatalogPermissionKey),
    memberCount: row.members,
    version: row.version,
  }
}

function byRank(a: RoleDto, b: RoleDto): number {
  const rank = (role: RoleDto) =>
    role.templateKey === null
      ? ROLE_TEMPLATE_KEYS.length
      : (TEMPLATE_RANK.get(role.templateKey) ?? ROLE_TEMPLATE_KEYS.length)
  return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

/** `role.list` (settings.members.view or settings.roles.manage): Owner first, then the templates. */
export async function listRoles(ctx: BusinessCtx): Promise<RoleDto[]> {
  const rows = await ctx.tx((tx) => roleRows(tx, ctx.businessId))
  return rows.map(toRoleDto).sort(byRank)
}

/**
 * `role.updatePermissions` (settings.roles.manage): replaces the keys a role grants. Keys must be in
 * the permission catalog, and a key that needs another (PERMISSION_NEEDS: changing needs seeing) comes
 * with it (VALIDATION); the Owner role cannot be edited (VALIDATION); `version` must be the role's
 * version (CONFLICT). A non-owner may edit only a role that grants nothing beyond their own access,
 * and add or remove only permissions they hold (FORBIDDEN), like assigning or removing members.
 */
export async function updateRolePermissions(
  ctx: BusinessCtx,
  input: UpdateRolePermissionsInput,
): Promise<RoleDto> {
  const wanted = [...new Set(input.permissionKeys)]
  const unknown = wanted.filter((key) => !isCatalogPermissionKey(key))
  if (unknown.length > 0) {
    throw new AppError('validation', { message: `unknown permission keys: ${unknown.join(', ')}` })
  }
  const row = await ctx.tx(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, templateKey: roles.templateKey, version: roles.version })
      .from(roles)
      .where(
        and(eq(roles.businessId, ctx.businessId), eq(roles.id, input.id), isNull(roles.deletedAt)),
      )
      .for('update')
    if (!role) throw new AppError('not_found')
    if (role.templateKey === OWNER_TEMPLATE_KEY) {
      throw new AppError('validation', { message: 'the Owner role has every permission' })
    }
    if (role.version !== input.version) throw new AppError('conflict')

    const current = new Set(
      (
        await tx
          .select({ key: rolePermissions.permissionKey })
          .from(rolePermissions)
          .where(
            and(
              eq(rolePermissions.businessId, ctx.businessId),
              eq(rolePermissions.roleId, role.id),
              isNull(rolePermissions.deletedAt),
            ),
          )
      ).map((r) => r.key),
    )
    // A role with more access than the caller's is left alone (it may hold people with more access).
    if (!canGrant(ctx.access, current)) {
      throw new AppError('forbidden', { message: 'cannot edit a role with more access than yours' })
    }
    const added = wanted.filter((key) => !current.has(key))
    const removed = [...current].filter((key) => !wanted.includes(key))
    if (!canGrant(ctx.access, [...added, ...removed])) {
      throw new AppError('forbidden', { message: 'cannot change permissions you do not have' })
    }
    const incomplete = keysMissingNeeds(wanted)
    if (incomplete.length > 0) {
      throw new AppError('validation', {
        message: `keys without the permission they need: ${incomplete.join(', ')}`,
      })
    }

    if (removed.length > 0) {
      await tx
        .update(rolePermissions)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(rolePermissions.businessId, ctx.businessId),
            eq(rolePermissions.roleId, role.id),
            inArray(rolePermissions.permissionKey, removed),
            isNull(rolePermissions.deletedAt),
          ),
        )
    }
    for (const permissionKey of added) {
      await tx
        .insert(rolePermissions)
        .values({ id: newId(), businessId: ctx.businessId, roleId: role.id, permissionKey })
        .onConflictDoUpdate({
          target: [
            rolePermissions.businessId,
            rolePermissions.roleId,
            rolePermissions.permissionKey,
          ],
          set: { deletedAt: null },
        })
    }
    // The role's version moves on every save (optimistic concurrency for the next edit), and every
    // member with the role refetches their access.
    await tx
      .update(roles)
      .set({ name: sql`name` })
      .where(and(eq(roles.businessId, ctx.businessId), eq(roles.id, role.id)))
    if (added.length > 0 || removed.length > 0) {
      await tx
        .update(businessMembers)
        .set({ permissionsVersion: sql`${businessMembers.permissionsVersion} + 1` })
        .where(
          and(
            eq(businessMembers.businessId, ctx.businessId),
            eq(businessMembers.roleId, role.id),
            isNull(businessMembers.deletedAt),
          ),
        )
      await revokeInvitationsBeyondSenders(tx, ctx.businessId)
    }
    const [saved] = await roleRows(tx, ctx.businessId, role.id)
    if (!saved) throw new AppError('not_found')
    return saved
  })
  return toRoleDto(row)
}
