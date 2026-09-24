import type { InvitationStatus, MemberKind, MemberStatus, PermissionEffect } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { citext, timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { locations } from './locations'

// Editable per-business roles, copied from the code role templates. template_key NULL = custom role;
// 'owner' (OWNER_TEMPLATE_KEY in @bizcost/domain) = every permission, implicitly.
export const roles = tenantTable('roles', {
  name: text('name').notNull(),
  templateKey: text('template_key'),
})

// Row present = permission granted. Keys come from the code permission catalog.
export const rolePermissions = tenantTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [
    tenantRef('role_permissions_role_fk', [t.businessId, t.roleId], roles),
    unique('role_permissions_business_id_role_id_permission_key_key').on(
      t.businessId,
      t.roleId,
      t.permissionKey,
    ),
  ],
)

// Membership = access to one business. `account` members have an auth user; `pin_only` staff do not.
// display_name is required for every kind: co-members' names are read from here, never from profiles.
export const businessMembers = tenantTable(
  'business_members',
  {
    userId: uuid('user_id'),
    kind: text('kind').$type<MemberKind>().notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<MemberStatus>().notNull(),
    roleId: uuid('role_id').notNull(),
    permissionsVersion: integer('permissions_version').notNull().default(1),
    // RESERVED for staff PIN login on a shared device (not built in M1). Never written to audit_log.
    pinHash: text('pin_hash'),
  },
  (t) => [
    tenantRef('business_members_role_fk', [t.businessId, t.roleId], roles),
    check('business_members_kind_check', sql`kind in ('account', 'pin_only')`),
    check('business_members_kind_user_check', sql`(kind = 'pin_only') = (user_id is null)`),
    check(
      'business_members_status_check',
      sql`status in ('invited', 'active', 'suspended', 'removed')`,
    ),
    uniqueIndex('business_members_user_key')
      .on(t.businessId, t.userId)
      .where(sql`user_id is not null and deleted_at is null`),
    // Per-user lookups across businesses: the own-memberships read policy and app.my_business_ids()
    // (business switcher) filter on user_id alone. One of the two indexes not led by business_id.
    index('business_members_user_idx')
      .on(t.userId)
      .where(sql`user_id is not null`),
    index('business_members_role_idx').on(t.businessId, t.roleId),
  ],
)

export const memberPermissionOverrides = tenantTable(
  'member_permission_overrides',
  {
    memberId: uuid('member_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    effect: text('effect').$type<PermissionEffect>().notNull(),
  },
  (t) => [
    tenantRef('member_permission_overrides_member_fk', [t.businessId, t.memberId], businessMembers),
    unique('member_permission_overrides_member_permission_key').on(
      t.businessId,
      t.memberId,
      t.permissionKey,
    ),
    check('member_permission_overrides_effect_check', sql`effect in ('allow', 'deny')`),
  ],
)

export const memberLocations = tenantTable(
  'member_locations',
  {
    memberId: uuid('member_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (t) => [
    tenantRef('member_locations_member_fk', [t.businessId, t.memberId], businessMembers),
    tenantRef('member_locations_location_fk', [t.businessId, t.locationId], locations),
    unique('member_locations_member_location_key').on(t.businessId, t.memberId, t.locationId),
    index('member_locations_location_idx').on(t.businessId, t.locationId),
  ],
)

// Only the SHA-256 hex of the invitation token is stored (and never written to audit_log); the raw
// token exists only in the email. Accepted through app.accept_invitation().
export const businessInvitations = tenantTable(
  'business_invitations',
  {
    email: citext('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    status: text('status').$type<InvitationStatus>().notNull().default('pending'),
    roleId: uuid('role_id').notNull(),
    overrides: jsonb('overrides')
      .$type<Record<string, PermissionEffect>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    locationIds: uuid('location_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // Rate-limit counters; the limits are counted in the DB by the API.
    sendCount: integer('send_count').notNull().default(0),
    lastSentAt: timestamptz('last_sent_at'),
  },
  (t) => [
    tenantRef('business_invitations_role_fk', [t.businessId, t.roleId], roles),
    // Global on purpose: acceptance finds the invitation by token before the business is known.
    unique('business_invitations_token_hash_key').on(t.tokenHash),
    uniqueIndex('business_invitations_one_pending_key')
      .on(t.businessId, sql`lower((email)::text)`)
      .where(sql`status = 'pending' and deleted_at is null`),
    index('business_invitations_role_idx').on(t.businessId, t.roleId),
    check(
      'business_invitations_status_check',
      sql`status in ('pending', 'accepted', 'revoked', 'expired')`,
    ),
    check('business_invitations_overrides_check', sql`jsonb_typeof(overrides) = 'object'`),
    check('business_invitations_send_count_check', sql`send_count >= 0`),
  ],
)

export type Role = typeof roles.$inferSelect
export type NewRole = typeof roles.$inferInsert
export type RolePermission = typeof rolePermissions.$inferSelect
export type NewRolePermission = typeof rolePermissions.$inferInsert
export type BusinessMember = typeof businessMembers.$inferSelect
export type NewBusinessMember = typeof businessMembers.$inferInsert
export type MemberPermissionOverride = typeof memberPermissionOverrides.$inferSelect
export type NewMemberPermissionOverride = typeof memberPermissionOverrides.$inferInsert
export type MemberLocation = typeof memberLocations.$inferSelect
export type NewMemberLocation = typeof memberLocations.$inferInsert
export type BusinessInvitation = typeof businessInvitations.$inferSelect
export type NewBusinessInvitation = typeof businessInvitations.$inferInsert
