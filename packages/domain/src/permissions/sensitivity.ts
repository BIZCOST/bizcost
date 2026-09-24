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
 * hidden value cannot be derived from visible ones (price + margin would reveal a hidden cost).
 */
export const SENSITIVITY_REQUIRES: {
  readonly [C in SensitivityCategory]: readonly SensitivityCategory[]
} = {
  cost: [],
  profit_margin: ['cost'],
  supplier_price: [],
  payroll: [],
  employee_pii: [],
}

export function isSensitivityCategory(value: unknown): value is SensitivityCategory {
  return (SENSITIVITY_CATEGORIES as readonly unknown[]).includes(value)
}

/** The categories this member may see: its permission is granted and the grouping rule holds. */
export function visibleCategories(
  effective: EffectivePermissions,
): ReadonlySet<SensitivityCategory> {
  const memo = new Map<SensitivityCategory, boolean>()
  const isVisible = (category: SensitivityCategory): boolean => {
    const known = memo.get(category)
    if (known !== undefined) return known
    const visible =
      can(effective, sensitivityPermissionKey(category)) &&
      SENSITIVITY_REQUIRES[category].every(isVisible)
    memo.set(category, visible)
    return visible
  }
  return new Set(SENSITIVITY_CATEGORIES.filter(isVisible))
}
