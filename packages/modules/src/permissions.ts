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
