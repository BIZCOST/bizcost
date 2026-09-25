import type { Tx } from '@bizcost/db'
import {
  isTerminologyProfile,
  resolveEffective,
  resolveLocationScope,
  visibleCategories,
  type EffectivePermissions,
  type LocationScope,
  type PermissionEffect,
  type SensitivityCategory,
  type TerminologyProfile,
} from '@bizcost/domain'
import {
  PERMISSION_CATALOG,
  resolveCapabilities,
  resolveEnabledModules,
  type Capabilities,
  type ModuleState,
} from '@bizcost/modules'
import { sql } from 'drizzle-orm'

/** What the caller may do in the active business, resolved once per request. */
export interface BusinessAccess {
  readonly memberId: string
  /** roles.template_key of the member's role; null for a custom (or deleted) role. */
  readonly roleTemplateKey: string | null
  readonly effective: EffectivePermissions
  readonly locationScope: LocationScope
  readonly visibleCategories: ReadonlySet<SensitivityCategory>
  /** Modules the business has on (resolveEnabledModules: core modules need no row). */
  readonly enabledModules: ReadonlySet<string>
  readonly capabilities: Capabilities
  /** businesses.terminology_profile ('general' for an unknown value). */
  readonly terminologyProfile: TerminologyProfile
  readonly permissionsVersion: number
}

interface AccessRow extends Record<string, unknown> {
  member_id: string
  permissions_version: number
  template_key: string | null
  vat_registered: boolean
  terminology_profile: string
  role_keys: string[]
  overrides: { key: string; effect: PermissionEffect }[]
  location_ids: string[]
  module_states: ModuleState[]
  capabilities: { key: string; enabled: boolean }[]
}

/**
 * Loads the caller's membership, role, role permissions, overrides, locations, enabled modules, stored
 * capabilities and businesses.vat_registered in ONE statement, inside the request's withTenantTx.
 * Returns null unless the caller is an active account member of a live business; RLS hides other
 * businesses entirely, and the caller's own non-active memberships are filtered out here.
 *
 * Soft-deleted locations stay in the scope on purpose: dropping them could empty a restricted scope,
 * and an empty scope means ALL locations (D-054).
 */
export async function loadBusinessAccess(
  tx: Tx,
  userId: string,
  businessId: string,
): Promise<BusinessAccess | null> {
  const rows = (await tx.execute(sql`
    select
      m.id as member_id,
      m.permissions_version,
      r.template_key,
      b.vat_registered,
      b.terminology_profile,
      coalesce((
        select array_agg(rp.permission_key)
        from app.role_permissions rp
        where rp.business_id = m.business_id and rp.role_id = r.id and rp.deleted_at is null
      ), '{}'::text[]) as role_keys,
      coalesce((
        select jsonb_agg(jsonb_build_object('key', o.permission_key, 'effect', o.effect))
        from app.member_permission_overrides o
        where o.business_id = m.business_id and o.member_id = m.id and o.deleted_at is null
      ), '[]'::jsonb) as overrides,
      coalesce((
        select array_agg(ml.location_id)
        from app.member_locations ml
        where ml.business_id = m.business_id and ml.member_id = m.id and ml.deleted_at is null
      ), '{}'::uuid[]) as location_ids,
      coalesce((
        select jsonb_agg(jsonb_build_object('key', bm.module_key, 'enabled', bm.enabled))
        from app.business_modules bm
        where bm.business_id = m.business_id and bm.deleted_at is null
      ), '[]'::jsonb) as module_states,
      coalesce((
        select jsonb_agg(jsonb_build_object('key', c.key, 'enabled', c.enabled))
        from app.business_capabilities c
        where c.business_id = m.business_id and c.deleted_at is null
      ), '[]'::jsonb) as capabilities
    from app.business_members m
    join app.businesses b on b.id = m.business_id and b.deleted_at is null
    left join app.roles r
      on r.business_id = m.business_id and r.id = m.role_id and r.deleted_at is null
    where m.business_id = ${businessId}
      and m.user_id = ${userId}
      and m.kind = 'account'
      and m.status = 'active'
      and m.deleted_at is null
  `)) as unknown as AccessRow[]

  const row = rows[0]
  if (!row) return null

  const effective = resolveEffective({
    roleTemplateKey: row.template_key,
    rolePermissionKeys: row.role_keys,
    overrides: row.overrides,
    catalog: PERMISSION_CATALOG,
  })
  return {
    memberId: row.member_id,
    roleTemplateKey: row.template_key,
    effective,
    locationScope: resolveLocationScope(row.location_ids),
    visibleCategories: visibleCategories(effective),
    enabledModules: resolveEnabledModules(row.module_states),
    capabilities: resolveCapabilities({
      stored: row.capabilities,
      derived: { vat_registered: row.vat_registered },
    }),
    terminologyProfile: isTerminologyProfile(row.terminology_profile)
      ? row.terminology_profile
      : 'general',
    permissionsVersion: row.permissions_version,
  }
}
