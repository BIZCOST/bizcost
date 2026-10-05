import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import { PERMISSION_CATALOG, type PermissionKey } from './permissions'

// Role templates (docs/PRODUCT.md §8, the owner's list). Each business gets editable copies:
// `roles.template_key` = the key and one `role_permissions` row per permission key. The owner template
// holds every permission implicitly and has no rows (D-049). A key added here later reaches the roles
// that businesses already have only through a migration that adds it to their template roles (the
// catalog_security migration of M2 Step 2 did so for the products and materials keys, D-124, and
// purchasing_security for the suppliers and purchases keys of M2 Step 3, recipes_security for the
// recipe keys of M2 Step 4, purchasing_payments_security for the payment keys of 2026-09-29,
// expenses_security for the expenses and running-costs keys of M2 Step 5, owners_answers_access for
// the Employee keys of the owner's answers of 2026-09-29, product_costs_access for the product-cost
// keys of M2 Step 6, sales_security for the sales keys of M3 Step 2, by the plan's Q10 table: an
// Employee enters and finalizes their own sales only, D-218).

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
      'products.items.view',
      'products.items.manage',
      'products.recipes.view',
      'products.recipes.manage',
      'materials.items.view',
      'materials.items.manage',
      'suppliers.items.view',
      'suppliers.items.manage',
      'purchases.documents.view',
      'purchases.documents.manage',
      'purchases.documents.post',
      'purchases.documents.reverse',
      'purchases.payments.view',
      'purchases.payments.record',
      'expenses.documents.view',
      'expenses.documents.manage',
      'expenses.documents.approve',
      'expenses.documents.post',
      'expenses.documents.reverse',
      'expenses.payments.view',
      'expenses.payments.record',
      'running_costs.items.view',
      'running_costs.items.manage',
      'cost_engine.product_costs.view',
      'cost_engine.settings.manage',
      'sales.documents.view',
      'sales.documents.manage',
      'sales.documents.post',
      'sales.documents.reverse',
      'sales.channels.manage',
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
      'products.items.view',
      'products.recipes.view',
      'materials.items.view',
      'suppliers.items.view',
      'purchases.documents.view',
      'expenses.documents.view',
      'running_costs.items.view',
      'cost_engine.product_costs.view',
      'sales.documents.view',
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
      'data.payroll.view',
    ],
  },
  {
    key: 'sales',
    allPermissions: false,
    permissionKeys: [
      'dashboard.home.view',
      'products.items.view',
      'sales.documents.view',
      'sales.documents.manage',
      'sales.documents.post',
    ],
  },
  {
    key: 'supervisor',
    allPermissions: false,
    permissionKeys: [
      'dashboard.home.view',
      'settings.members.view',
      'products.items.view',
      'products.recipes.view',
      'materials.items.view',
      'sales.documents.view',
      'sales.documents.manage',
      'sales.documents.post',
    ],
  },
  // The owner's answers of 2026-09-29 (D-179, D-180): an employee sees what goes into each product
  // (quantities; costs stay locked) and the materials it names, and enters expenses and sends them for
  // approval. No sensitive key. M3 Step 2 (Q10): they enter and finalize sales, and see only their own
  // (no "see every sale").
  {
    key: 'employee',
    allPermissions: false,
    permissionKeys: [
      'dashboard.home.view',
      'products.items.view',
      'products.recipes.view',
      'materials.items.view',
      'expenses.documents.view',
      'expenses.documents.manage',
      'sales.documents.manage',
      'sales.documents.post',
    ],
  },
]

export function isRoleTemplateKey(value: unknown): value is RoleTemplateKey {
  return (ROLE_TEMPLATE_KEYS as readonly unknown[]).includes(value)
}

export function roleTemplateByKey(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key)
}
