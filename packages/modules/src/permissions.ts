import { SENSITIVITY_PERMISSION_KEYS, type SensitivityPermissionKey } from '@bizcost/domain'
import { MODULES, type ModulePermissionKey } from './manifests'

// Permission catalog: every valid key. Module keys come from the manifests; the data-visibility keys
// (`data.<category>.view`, one per sensitivity category) unlock sensitive fields across modules.
// The engine in @bizcost/domain receives this list and drops any key outside it.

export type PermissionKey = ModulePermissionKey | SensitivityPermissionKey

export const PERMISSION_CATALOG: readonly PermissionKey[] = [
  ...MODULES.flatMap((m): readonly ModulePermissionKey[] => m.permissionKeys),
  ...SENSITIVITY_PERMISSION_KEYS,
]

const CATALOG_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOG)

export function isCatalogPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && CATALOG_SET.has(value)
}

/**
 * Permissions that make sense only with another one: changing something needs seeing it. A role that
 * grants a key here must also grant the key it needs (role.updatePermissions refuses anything else;
 * the Roles editor switches both together).
 */
export const PERMISSION_NEEDS: Readonly<Partial<Record<PermissionKey, PermissionKey>>> = {
  'settings.business.edit': 'settings.business.view',
  'settings.members.manage': 'settings.members.view',
}

/** The keys of `keys` granted without the key they need (empty when the set is coherent). */
export function keysMissingNeeds(keys: Iterable<string>): PermissionKey[] {
  const set = new Set(keys)
  const missing: PermissionKey[] = []
  for (const [key, needed] of Object.entries(PERMISSION_NEEDS) as [
    PermissionKey,
    PermissionKey,
  ][]) {
    if (set.has(key) && !set.has(needed)) missing.push(key)
  }
  return missing
}
