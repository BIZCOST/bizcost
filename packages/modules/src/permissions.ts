import {
  SENSITIVITY_CATEGORIES,
  SENSITIVITY_PERMISSION_KEYS,
  SENSITIVITY_REQUIRES,
  sensitivityPermissionKey,
  type EffectivePermissions,
  type SensitivityCategory,
  type SensitivityPermissionKey,
} from '@bizcost/domain'
import { MODULES, type ModuleManifest, type ModulePermissionKey } from './manifests'

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
 * The data keys a data key needs: those of the categories its category is visible only with
 * (SENSITIVITY_REQUIRES: costs, supplier prices and margins only together, D-144, D-187).
 */
const DATA_NEEDS = Object.fromEntries(
  SENSITIVITY_CATEGORIES.filter((category) => SENSITIVITY_REQUIRES[category].length > 0).map(
    (category) => [
      sensitivityPermissionKey(category),
      SENSITIVITY_REQUIRES[category].map(sensitivityPermissionKey),
    ],
  ),
) as Partial<Record<PermissionKey, readonly PermissionKey[]>>

/**
 * Permissions that make sense only with others: changing something needs seeing it, and seeing what
 * goes into each product needs seeing the materials it names (a recipe shows their averages with its
 * costs, D-155), and seeing product costs needs seeing what goes into them (their breakdown shows
 * it). The data keys of costs, supplier prices and margins need each other (they are visible only
 * together, D-187), so they are granted and taken away as one. Approving expenses and recording
 * payments need supplier prices: each use shows or settles what was paid (the API refuses them without,
 * D-160, D-175), so the costs switch takes them with it (D-200). A role, or a member's own access, that
 * grants a key here must also grant every key it needs, and the keys those need (role.updatePermissions
 * and member.updatePermissions refuse anything else; the editors switch them together).
 */
export const PERMISSION_NEEDS: Readonly<Partial<Record<PermissionKey, readonly PermissionKey[]>>> =
  {
    ...DATA_NEEDS,
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
    'purchases.payments.view': ['purchases.documents.view'],
    'purchases.payments.record': ['purchases.payments.view', 'data.supplier_price.view'],
    'expenses.documents.manage': ['expenses.documents.view'],
    'expenses.documents.approve': ['expenses.documents.view', 'data.supplier_price.view'],
    'expenses.documents.post': ['expenses.documents.view'],
    'expenses.documents.reverse': ['expenses.documents.view'],
    'expenses.payments.view': ['expenses.documents.view'],
    'expenses.payments.record': ['expenses.payments.view', 'data.supplier_price.view'],
    'expenses.approval.manage': ['expenses.documents.view'],
    'running_costs.items.manage': ['running_costs.items.view'],
    // Product costs (M2 Step 6): each product's breakdown names what goes into it (its recipe).
    'cost_engine.product_costs.view': ['products.recipes.view'],
    'cost_engine.settings.manage': ['cost_engine.product_costs.view'],
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

/**
 * A member's permissions without the keys that miss a key they need (PERMISSION_NEEDS), taken out
 * until nothing changes: what the API and the screens act on. A role is saved only whole, but a
 * member's overrides or a later change of their role can leave a key without what it needs (e.g.
 * "see what goes into each product" allowed to one member whose role does not see materials); such a
 * key grants nothing. The owner holds every key.
 */
export function withNeededKeys(effective: EffectivePermissions): EffectivePermissions {
  if (effective.all) return effective
  const keys = new Set(effective.keys)
  let changed = true
  while (changed) {
    changed = false
    for (const key of keys) {
      const needed = PERMISSION_NEEDS[key as PermissionKey]
      if (needed?.some((n) => !keys.has(n))) {
        keys.delete(key)
        changed = true
      }
    }
  }
  return keys.size === effective.keys.size ? effective : { all: false, keys }
}

/**
 * A switch of the sensitive-data section (the Roles editor and a member's own access): the data keys
 * it grants together, and the sensitivity categories it shows. Costs, supplier prices and margins are
 * one switch, "See costs, supplier prices and margins" (D-144, D-187); payroll and employees' personal
 * data are their own once a module shows them (Phase 5).
 */
export interface SensitiveDataSwitch {
  readonly id: 'costs' | 'payroll' | 'employee_pii'
  readonly categories: readonly SensitivityCategory[]
  readonly keys: readonly SensitivityPermissionKey[]
}

export const SENSITIVE_DATA_SWITCHES: readonly SensitiveDataSwitch[] = [
  {
    id: 'costs',
    categories: ['cost', 'supplier_price', 'profit_margin'],
    keys: ['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view'],
  },
  { id: 'payroll', categories: ['payroll'], keys: ['data.payroll.view'] },
  { id: 'employee_pii', categories: ['employee_pii'], keys: ['data.employee_pii.view'] },
]

/**
 * The sensitive-data switches to offer for a business: those whose categories a module it has on
 * (released and enabled, e.g. business.context.modules) outputs. Today: "costs" with the Costing Core
 * on. A switch not offered keeps its keys on a role as they are when the role is saved (D-084).
 */
export function offeredSensitiveDataSwitches(
  moduleIds: Iterable<string>,
  manifests: readonly ModuleManifest[] = MODULES,
): readonly SensitiveDataSwitch[] {
  const on = new Set(moduleIds)
  const shown = new Set<SensitivityCategory>(
    manifests.filter((m) => on.has(m.id)).flatMap((m) => m.sensitiveFields),
  )
  return SENSITIVE_DATA_SWITCHES.filter((s) => s.categories.some((c) => shown.has(c)))
}
