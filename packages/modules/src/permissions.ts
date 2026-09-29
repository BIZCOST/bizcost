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
 * Permissions that make sense only with others: changing something needs seeing it, and seeing what
 * goes into each product needs seeing the materials it names (a recipe shows their averages with its
 * costs, D-155). A role that grants a key here must also grant every key it needs, and the keys those
 * need (role.updatePermissions refuses anything else; the Roles editor switches them together).
 */
export const PERMISSION_NEEDS: Readonly<Partial<Record<PermissionKey, readonly PermissionKey[]>>> =
  {
    'settings.business.edit': ['settings.business.view'],
    'settings.members.manage': ['settings.members.view'],
    'products.items.manage': ['products.items.view'],
    'products.recipes.view': ['products.items.view', 'materials.items.view'],
    'products.recipes.manage': ['products.recipes.view'],
    'materials.items.manage': ['materials.items.view'],
    'suppliers.items.manage': ['suppliers.items.view'],
    'purchases.documents.manage': ['purchases.documents.view'],
    'purchases.documents.post': ['purchases.documents.view'],
    'purchases.documents.reverse': ['purchases.documents.view'],
    'purchases.books.close': ['purchases.documents.view'],
    'purchases.payments.view': ['purchases.documents.view'],
    'purchases.payments.record': ['purchases.payments.view'],
    'expenses.documents.manage': ['expenses.documents.view'],
    'expenses.documents.approve': ['expenses.documents.view'],
    'expenses.documents.post': ['expenses.documents.view'],
    'expenses.documents.reverse': ['expenses.documents.view'],
    'expenses.payments.view': ['expenses.documents.view'],
    'expenses.payments.record': ['expenses.payments.view'],
    'expenses.approval.manage': ['expenses.documents.view'],
    'running_costs.items.manage': ['running_costs.items.view'],
  }

/** The keys of `keys` granted without a key they need (empty when the set is coherent). */
export function keysMissingNeeds(keys: Iterable<string>): PermissionKey[] {
  const set = new Set(keys)
  const missing: PermissionKey[] = []
  for (const [key, needed] of Object.entries(PERMISSION_NEEDS) as [
    PermissionKey,
    readonly PermissionKey[],
  ][]) {
    if (set.has(key) && needed.some((n) => !set.has(n))) missing.push(key)
  }
  return missing
}
