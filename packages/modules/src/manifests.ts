import type { NavEntryDto, QuickActionDto } from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { CapabilityKey } from './capabilities'

// Module manifests (docs/ARCHITECTURE.md §Modules): the single source for navigation, "+" actions,
// Smart Setup, API guards and Customize BizCost. Every module of PRODUCT.md §7 has one line here.
// A planned module gets its permission keys and nav when its build starts (Products & Services and
// Materials in M2 Step 2, D-124) and stays hidden until it is released: nav, tabs, "+" and the API
// gates count only released modules (the dev-only preview of registry.ts aside, D-125). Modules not
// being built carry no permission keys, nav or actions.

export const MODULE_IDS = [
  'dashboard',
  'settings',
  'products',
  'materials',
  'suppliers',
  'purchases',
  'expenses',
  'running_costs',
  'files',
  'cost_engine',
  'customers',
  'sales',
  'payments',
  'reports',
  'orders',
  'quotations',
  'invoices',
  'inventory',
  'usage_waste',
  'employees',
  'attendance',
  'payroll',
  'equipment',
  'vehicles',
  'projects',
  'petty_cash',
  'vat_center',
] as const
export type ModuleId = (typeof MODULE_IDS)[number]

export function isModuleId(value: unknown): value is ModuleId {
  return (MODULE_IDS as readonly unknown[]).includes(value)
}

export type ModuleKind = 'core' | 'optional'
export type ModuleAvailability = 'released' | 'planned'

/**
 * A navigation entry (sidebar, tabs). Without `permission` every member of the business sees it.
 * `labelKey` is a common `nav.*` key; `icon` a lucide icon name the web app maps to its icon (an
 * unknown name gets a neutral one, so a new module shows without changes to the shell).
 */
export interface NavEntry extends NavEntryDto {
  readonly permission?: string
}

export interface QuickAction extends QuickActionDto {
  readonly permission?: string
}

export interface ModuleManifest {
  readonly id: ModuleId
  readonly kind: ModuleKind
  /** Only released modules are ever shown (no placeholder screens). */
  readonly availability: ModuleAvailability
  /** Roadmap phase in which the module first ships (ROADMAP.md). */
  readonly phase: number
  /** Modules this one cannot work without (Customize BizCost warns before disabling them). */
  readonly deps: readonly ModuleId[]
  /** `module.resource.action` keys; each starts with the module id. */
  readonly permissionKeys: readonly string[]
  readonly nav: readonly NavEntry[]
  readonly quickActions: readonly QuickAction[]
  /** Sensitivity categories of the data this module outputs. */
  readonly sensitiveFields: readonly SensitivityCategory[]
  /** Capabilities the business must have for this module to make sense. */
  readonly requiresCapabilities: readonly CapabilityKey[]
}

const DASHBOARD = {
  id: 'dashboard',
  kind: 'core',
  availability: 'released',
  phase: 1,
  deps: [],
  permissionKeys: ['dashboard.home.view'],
  nav: [
    {
      id: 'dashboard',
      labelKey: 'nav.dashboard',
      path: '',
      icon: 'layout-dashboard',
      group: 'main',
      permission: 'dashboard.home.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Settings includes Locations (PRODUCT.md §7). Its nav entry has no permission: every member reaches
// their own profile and language there; each section checks its own key.
const SETTINGS = {
  id: 'settings',
  kind: 'core',
  availability: 'released',
  phase: 1,
  deps: [],
  permissionKeys: [
    'settings.business.view',
    'settings.business.edit',
    'settings.locations.manage',
    'settings.members.view',
    'settings.members.manage',
    'settings.roles.manage',
    'settings.modules.manage',
  ],
  nav: [
    {
      id: 'settings',
      labelKey: 'nav.settings',
      path: 'settings',
      icon: 'settings',
      group: 'system',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Products & Services (M2 Step 2; planned until Step 7 releases the M2 modules together). Recipes (M2
// Step 4, D-149): what each product or service uses, and what its materials cost (`cost`). A recipe
// names materials, so its procedures also need the Materials module on.
const PRODUCTS = {
  id: 'products',
  kind: 'core',
  availability: 'planned',
  phase: 2,
  deps: [],
  permissionKeys: [
    'products.items.view',
    'products.items.manage',
    'products.recipes.view',
    'products.recipes.manage',
  ],
  nav: [
    {
      id: 'products',
      labelKey: 'nav.products',
      path: 'products',
      icon: 'tag',
      group: 'main',
      permission: 'products.items.view',
    },
  ],
  quickActions: [],
  // The product cost (M2 Step 4): what its materials cost at their average.
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Materials (M2 Step 2; planned until Step 7). Material cost comes only from purchases (PRODUCT.md
// §4.8), hence the dependency.
const MATERIALS = {
  id: 'materials',
  kind: 'core',
  availability: 'planned',
  phase: 2,
  deps: ['purchases'],
  permissionKeys: ['materials.items.view', 'materials.items.manage'],
  nav: [
    {
      id: 'materials',
      labelKey: 'nav.materials',
      path: 'materials',
      icon: 'package',
      group: 'main',
      permission: 'materials.items.view',
    },
  ],
  quickActions: [],
  // The cost view (M2 Step 3): its average cost, and its last purchase price.
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Suppliers (M2 Step 3; planned until Step 7): a list of its own, separate from customers (D-112).
const SUPPLIERS = {
  id: 'suppliers',
  kind: 'core',
  availability: 'planned',
  phase: 2,
  deps: [],
  permissionKeys: ['suppliers.items.view', 'suppliers.items.manage'],
  nav: [
    {
      id: 'suppliers',
      labelKey: 'nav.suppliers',
      path: 'suppliers',
      icon: 'truck',
      group: 'main',
      permission: 'suppliers.items.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Purchases (M2 Step 3; planned until Step 7): purchases, supplier returns and credit notes, posted
// with the weighted average (D-114, D-120), their receipts (attachments), and the "books closed up
// to" date. Materials depend on it (their cost comes from purchases); the reverse would be a cycle,
// so Purchases lists no deps. The supplier of a purchase is optional (no dependency either).
const PURCHASES = {
  id: 'purchases',
  kind: 'core',
  availability: 'planned',
  phase: 2,
  deps: [],
  permissionKeys: [
    'purchases.documents.view',
    'purchases.documents.manage',
    'purchases.documents.post',
    'purchases.documents.reverse',
    'purchases.books.close',
  ],
  nav: [
    {
      id: 'purchases',
      labelKey: 'nav.purchases',
      path: 'purchases',
      icon: 'shopping-cart',
      group: 'main',
      permission: 'purchases.documents.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

interface PlannedManifest extends ModuleManifest {
  readonly availability: 'planned'
  readonly permissionKeys: readonly []
  readonly nav: readonly []
  readonly quickActions: readonly []
}

function planned(
  id: ModuleId,
  kind: ModuleKind,
  phase: number,
  links: {
    deps?: readonly ModuleId[]
    requiresCapabilities?: readonly CapabilityKey[]
  } = {},
): PlannedManifest {
  return {
    id,
    kind,
    availability: 'planned',
    phase,
    deps: links.deps ?? [],
    permissionKeys: [],
    nav: [],
    quickActions: [],
    sensitiveFields: [],
    requiresCapabilities: links.requiresCapabilities ?? [],
  }
}

// Same order as MODULE_IDS. deps/requiresCapabilities follow PRODUCT.md §5–§7 (Smart Setup relies on
// them, §6.6) and are reviewed when each module is built.
export const MODULES = [
  DASHBOARD,
  SETTINGS,
  PRODUCTS,
  MATERIALS,
  SUPPLIERS,
  PURCHASES,
  planned('expenses', 'core', 2),
  planned('running_costs', 'core', 2),
  planned('files', 'core', 2),
  planned('cost_engine', 'core', 2),
  planned('customers', 'core', 3),
  planned('sales', 'core', 3),
  planned('payments', 'core', 3),
  planned('reports', 'core', 3),
  planned('orders', 'optional', 3, { deps: ['products', 'customers', 'payments'] }),
  planned('quotations', 'optional', 3, { deps: ['products', 'customers'] }),
  // No requiresCapabilities: a business that is not VAT-registered sends plain invoices (§6.6).
  planned('invoices', 'optional', 3, { deps: ['products', 'customers', 'payments'] }),
  planned('inventory', 'optional', 4, {
    deps: ['materials'],
    requiresCapabilities: ['keeps_stock'],
  }),
  planned('usage_waste', 'optional', 4, {
    deps: ['inventory'],
    requiresCapabilities: ['keeps_stock'],
  }),
  planned('employees', 'optional', 5, { requiresCapabilities: ['has_team'] }),
  planned('attendance', 'optional', 5, {
    deps: ['employees'],
    requiresCapabilities: ['has_team'],
  }),
  planned('payroll', 'optional', 5, { deps: ['employees'], requiresCapabilities: ['has_team'] }),
  planned('equipment', 'optional', 5, { requiresCapabilities: ['uses_machines'] }),
  planned('vehicles', 'optional', 5),
  planned('projects', 'optional', 5, { deps: ['customers', 'payments'] }),
  planned('petty_cash', 'optional', 5, {
    deps: ['employees'],
    requiresCapabilities: ['has_team'],
  }),
  planned('vat_center', 'optional', 5, { requiresCapabilities: ['vat_registered'] }),
] as const satisfies readonly ModuleManifest[]

/** Permission keys declared by module manifests (the data-visibility keys are added in the catalog). */
export type ModulePermissionKey = (typeof MODULES)[number]['permissionKeys'][number]

/**
 * Core modules that are always on: the business cannot switch them off, and business_modules rows for
 * them are ignored. Other core modules are on until a row switches them off; optional modules are on
 * only through an enabled row (resolveEnabledModules).
 */
export const ALWAYS_ENABLED_MODULE_IDS: readonly ModuleId[] = ['dashboard', 'settings']
