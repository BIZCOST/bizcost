import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import { PERMISSION_CATALOG, type PermissionKey } from './permissions'

// Role templates (docs/PRODUCT.md §8, the owner's list). Each business gets editable copies:
// `roles.template_key` = the key and one `role_permissions` row per permission key. The owner template
// holds every permission implicitly and has no rows (D-049).

export const ROLE_TEMPLATE_KEYS = [
  OWNER_TEMPLATE_KEY,
  'admin',
  'manager',
  'accountant',
  'sales',
  'supervisor',
  'employee',
] as const
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number]

export interface RoleTemplate {
  readonly key: RoleTemplateKey
  /** True only for the owner: every permission, now and later, with no role_permissions rows. */
  readonly allPermissions: boolean
  /** The role_permissions rows to create. Empty for the owner. */
  readonly permissionKeys: readonly PermissionKey[]
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: OWNER_TEMPLATE_KEY, allPermissions: true, permissionKeys: [] },
  // Everything as rows. Ownership transfer is owner-only and is not a permission key.
  { key: 'admin', allPermissions: false, permissionKeys: PERMISSION_CATALOG },
  {
    key: 'manager',
    allPermissions: false,
    permissionKeys: [
      'dashboard.home.view',
      'settings.business.view',
      'settings.members.view',
      'settings.locations.manage',
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
    ],
  },
  {
    key: 'accountant',
    allPermissions: false,
    permissionKeys: [
      'dashboard.home.view',
      'settings.business.view',
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
      'data.payroll.view',
    ],
  },
  { key: 'sales', allPermissions: false, permissionKeys: ['dashboard.home.view'] },
  {
    key: 'supervisor',
    allPermissions: false,
    permissionKeys: ['dashboard.home.view', 'settings.members.view'],
  },
  { key: 'employee', allPermissions: false, permissionKeys: ['dashboard.home.view'] },
]

export function isRoleTemplateKey(value: unknown): value is RoleTemplateKey {
  return (ROLE_TEMPLATE_KEYS as readonly unknown[]).includes(value)
}

export function roleTemplateByKey(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key)
}
