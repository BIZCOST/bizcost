import { can, type EffectivePermissions } from './effective'

// Sensitive data the server removes from responses unless the member may see it
// (docs/ARCHITECTURE.md §Permissions, Redaction). Each category is unlocked by one permission key.

export const SENSITIVITY_CATEGORIES = [
  'cost',
  'profit_margin',
  'supplier_price',
  'payroll',
  'employee_pii',
] as const
export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number]

export type SensitivityPermissionKey = `data.${SensitivityCategory}.view`

export function sensitivityPermissionKey<C extends SensitivityCategory>(
  category: C,
): `data.${C}.view` {
  return `data.${category}.view`
}

export const SENSITIVITY_PERMISSION_KEYS: readonly SensitivityPermissionKey[] =
  SENSITIVITY_CATEGORIES.map(sensitivityPermissionKey)

/**
 * Grouping rule: a category is visible only when every category listed here is visible too, so a
 * hidden value cannot be derived from visible ones: price + margin would reveal a hidden cost. Costs
 * and supplier prices go together (D-140, D-144): the prices paid reveal the average they make, and
 * the average read before and after a purchase (or with the other purchases returned) reveals each
 * price paid. A rule may name a category that names it back: the pair is then visible only together.
 */
export const SENSITIVITY_REQUIRES: {
  readonly [C in SensitivityCategory]: readonly SensitivityCategory[]
} = {
  cost: ['supplier_price'],
  profit_margin: ['cost'],
  supplier_price: ['cost'],
  payroll: [],
  employee_pii: [],
}

export function isSensitivityCategory(value: unknown): value is SensitivityCategory {
  return (SENSITIVITY_CATEGORIES as readonly unknown[]).includes(value)
}

/**
 * The categories this member may see: its permission is granted and the grouping rule holds. Starting
 * from the granted categories, any whose required categories are not all still in the set is taken
 * out, until nothing changes (the largest set that follows the rule, also when rules name each other).
 */
export function visibleCategories(
  effective: EffectivePermissions,
): ReadonlySet<SensitivityCategory> {
  const visible = new Set(
    SENSITIVITY_CATEGORIES.filter((category) => can(effective, sensitivityPermissionKey(category))),
  )
  let changed = true
  while (changed) {
    changed = false
    for (const category of visible) {
      if (!SENSITIVITY_REQUIRES[category].every((required) => visible.has(required))) {
        visible.delete(category)
        changed = true
      }
    }
  }
  return visible
}
