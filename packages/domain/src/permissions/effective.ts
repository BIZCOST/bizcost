import { OWNER_TEMPLATE_KEY, type PermissionEffect } from '../tenancy/keys'

// Effective permissions of one member in one business (docs/ARCHITECTURE.md §Permissions).
// Pure: the caller loads the role's rows, the member's overrides and the code catalog.

/** One `member_permission_overrides` row. */
export interface PermissionOverride {
  readonly key: string
  readonly effect: PermissionEffect
}

export interface ResolveEffectiveInput {
  /** `roles.template_key` of the member's role; null for a custom role. */
  readonly roleTemplateKey: string | null
  /** `role_permissions.permission_key` rows of the member's role. */
  readonly rolePermissionKeys: readonly string[]
  readonly overrides: readonly PermissionOverride[]
  /** Every valid permission key (the code catalog). Keys outside it are never granted. */
  readonly catalog: readonly string[]
}

export interface EffectivePermissions {
  /** True only for the owner template: every permission, including keys added to the catalog later. */
  readonly all: boolean
  /** Granted catalog keys. For the owner this is the whole catalog. */
  readonly keys: ReadonlySet<string>
}

/**
 * Owner template → everything; overrides are ignored so an owner can never be locked out.
 * Everyone else → (role keys ∪ allow overrides) − deny overrides, limited to the catalog.
 * Deny wins over both the role and an allow override for the same key.
 */
export function resolveEffective(input: ResolveEffectiveInput): EffectivePermissions {
  const catalog = new Set(input.catalog)
  if (input.roleTemplateKey === OWNER_TEMPLATE_KEY) return { all: true, keys: catalog }

  const keys = new Set<string>()
  const denied = new Set<string>()
  for (const key of input.rolePermissionKeys) {
    if (catalog.has(key)) keys.add(key)
  }
  for (const { key, effect } of input.overrides) {
    if (effect === 'deny') denied.add(key)
    else if (effect === 'allow' && catalog.has(key)) keys.add(key)
  }
  for (const key of denied) keys.delete(key)
  return { all: false, keys }
}

/** Whether the member holds the permission. The owner holds every key. */
export function can(effective: EffectivePermissions, key: string): boolean {
  return effective.all || effective.keys.has(key)
}
