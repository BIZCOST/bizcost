import type { NavEntryDto, QuickActionDto } from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { CapabilityKey } from './capabilities'

// Module manifests (docs/ARCHITECTURE.md §Modules): the single source for navigation, "+" actions,
// Smart Setup, API guards and Customize BizCost. Every module of PRODUCT.md §7 has one line here.
// A planned module gets its permission keys and nav when its build starts (Products & Services and
// Materials in M2 Step 2, D-124) and stays hidden until it is released: nav, tabs, "+" and the API
// gates count only released modules (the dev-only preview of registry.ts aside, D-125). Modules not
// being built carry no permission keys, nav or actions. M2 Step 7 released the Costing Core
// (Products & Services, Materials, Suppliers, Purchases, Expenses, Running Costs, Files and the Cost
// Engine) together.

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
 * unknown name gets a neutral one, so a new module shows without changes to the shell). `tab`: its
 * claim to a place in the phone's tab bar when the member's entries do not all fit (1 first); without
 * it the entry goes under "More" then. The tabs keep the nav's order (M2 Step 7: an owner gets Home,
 * Products, "+", Product costs, More; an employee keeps Expenses, D-184).
 */
export interface NavEntry extends Omit<NavEntryDto, 'tab'> {
  readonly tab?: number
  readonly permission?: string
  /**
   * Also shown, whatever the member's keys, to a member the business owes (or paid back) for
   * something they paid from their own money in this module: "Owed to me" on Amounts owed (the
   * owner's answers of 2026-09-29, D-181). The page then shows them their own records only.
   */
  readonly payees?: true
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
      tab: 1,
      permission: 'dashboard.home.view',
    },
  ],
  quickActions: [],
  sensitiveFields: [],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Settings includes Locations (PRODUCT.md §7). Its nav entry has no permission: every member reaches
// their own profile and language there; each section checks its own key. Closing the books
// (`settings.books.close`, D-114 rule 6) is a Settings key since M2 Step 7 (D-201): purchases and
// expenses both obey the date, so it works with either of them on.
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
    'settings.books.close',
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

// Products & Services (M2 Step 2; released with the Costing Core in Step 7). Recipes (M2 Step 4,
// D-149): what each product or service uses, and what its materials cost (`cost`). A recipe names
// materials, so its procedures also need the Materials module on. "+": a new product or service.
const PRODUCTS = {
  id: 'products',
  kind: 'core',
  availability: 'released',
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
      tab: 3,
      permission: 'products.items.view',
    },
  ],
  quickActions: [
    {
      id: 'new_product',
      labelKey: 'nav.new_product',
      path: 'products/new',
      icon: 'tag',
      permission: 'products.items.manage',
    },
  ],
  // The product cost (M2 Step 4): what its materials cost at their average.
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Materials (M2 Step 2; released in Step 7). Material cost comes only from purchases (PRODUCT.md
// §4.8), hence the dependency.
const MATERIALS = {
  id: 'materials',
  kind: 'core',
  availability: 'released',
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
      tab: 6,
      permission: 'materials.items.view',
    },
  ],
  quickActions: [],
  // The cost view (M2 Step 3): its average cost, and its last purchase price.
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Suppliers (M2 Step 3; released in Step 7): a list of its own, separate from customers (D-112).
const SUPPLIERS = {
  id: 'suppliers',
  kind: 'core',
  availability: 'released',
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

// Purchases (M2 Step 3; released in Step 7): purchases, supplier returns and credit notes, posted
// with the weighted average (D-114, D-120), their receipts (attachments), and what the business still
// owes on purchases bought on credit or paid by a member, with the payments of it (the owner's request of 2026-09-29, D-160; its own nav entry, "Amounts owed").
// Materials depend on it (their cost comes from purchases); the reverse would be a cycle, so
// Purchases lists no deps. The supplier of a purchase is optional (no dependency either). "+": a new
// purchase.
const PURCHASES = {
  id: 'purchases',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [
    'purchases.documents.view',
    'purchases.documents.manage',
    'purchases.documents.post',
    'purchases.documents.reverse',
    'purchases.payments.view',
    'purchases.payments.record',
  ],
  nav: [
    {
      id: 'purchases',
      labelKey: 'nav.purchases',
      path: 'purchases',
      icon: 'shopping-cart',
      group: 'main',
      tab: 5,
      permission: 'purchases.documents.view',
    },
    {
      id: 'payables',
      labelKey: 'nav.payables',
      path: 'payables',
      icon: 'hand-coins',
      group: 'main',
      permission: 'purchases.payments.view',
      payees: true,
    },
  ],
  quickActions: [
    {
      id: 'new_purchase',
      labelKey: 'nav.new_purchase',
      path: 'purchases/new',
      icon: 'shopping-cart',
      permission: 'purchases.documents.manage',
    },
  ],
  sensitiveFields: ['cost', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Expenses (M2 Step 5; released in Step 7): one amount in a category (shared with Running Costs,
// D-116), its document type apart from how it was paid (PRODUCT.md §4 rule 13), receipts, and an
// optional approval before it is final (with a team, D-164). An expense bought on credit or paid by a
// member is owed until paid, next to purchases in "Amounts owed" (D-166): the page is one, listed by
// whichever module comes first (the registry lists a path once). Amounts are `supplier_price`
// (D-165). The supplier is optional, so no dependency on Suppliers. "+": a new expense (staff enter
// theirs, D-180).
const EXPENSES = {
  id: 'expenses',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [
    'expenses.documents.view',
    'expenses.documents.manage',
    'expenses.documents.approve',
    'expenses.documents.post',
    'expenses.documents.reverse',
    'expenses.payments.view',
    'expenses.payments.record',
    'expenses.approval.manage',
  ],
  nav: [
    {
      id: 'expenses',
      labelKey: 'nav.expenses',
      path: 'expenses',
      icon: 'receipt',
      group: 'main',
      tab: 4,
      permission: 'expenses.documents.view',
    },
    {
      id: 'payables',
      labelKey: 'nav.payables',
      path: 'payables',
      icon: 'hand-coins',
      group: 'main',
      permission: 'expenses.payments.view',
      payees: true,
    },
  ],
  quickActions: [
    {
      id: 'new_expense',
      labelKey: 'nav.new_expense',
      path: 'expenses/new',
      icon: 'receipt',
      permission: 'expenses.documents.manage',
    },
  ],
  sensitiveFields: ['supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Running Costs (M2 Step 5; released in Step 7): "What do you pay to run your business?" Regular
// amounts per period in the categories shared with Expenses, turned into monthly amounts that Step 6
// shares over product costs (D-116). Never posted. Amounts are `cost` (D-165).
const RUNNING_COSTS = {
  id: 'running_costs',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: ['running_costs.items.view', 'running_costs.items.manage'],
  nav: [
    {
      id: 'running_costs',
      labelKey: 'nav.running_costs',
      path: 'running-costs',
      icon: 'repeat',
      group: 'main',
      permission: 'running_costs.items.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Cost Engine (M2 Step 6; released in Step 7): "Product costs", each product's cost for one unit
// sold, line by line (its materials at their averages, D-115; the running-cost share of its material
// cost, D-116; the owner's time without a team, D-119) and its margin on the price before VAT, worked
// out on read; and how it is worked out (the owner's estimate of monthly purchases and hourly rate).
// Costs are `cost`, margins `profit_margin`, the monthly purchases `supplier_price`. Its breakdown
// shows recipes, so seeing it needs seeing what goes into each product (PERMISSION_NEEDS).
const COST_ENGINE = {
  id: 'cost_engine',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: ['products'],
  permissionKeys: ['cost_engine.product_costs.view', 'cost_engine.settings.manage'],
  nav: [
    {
      id: 'product_costs',
      labelKey: 'nav.product_costs',
      path: 'product-costs',
      icon: 'calculator',
      group: 'main',
      tab: 2,
      permission: 'cost_engine.product_costs.view',
    },
  ],
  quickActions: [],
  sensitiveFields: ['cost', 'profit_margin', 'supplier_price'],
  requiresCapabilities: [],
} as const satisfies ModuleManifest

// Files (released with the Costing Core in Step 7): receipts and documents attached to records. It
// has no page of its own: its files show inside the records they belong to (a purchase's or an
// expense's receipts), and attachment.* need it on as well as the record's own module and keys. With
// it off, receipts are hidden in those screens and the API refuses them (MODULE_DISABLED). A
// receipt's download URL is a supplier price (it shows what was paid).
const FILES = {
  id: 'files',
  kind: 'core',
  availability: 'released',
  phase: 2,
  deps: [],
  permissionKeys: [],
  nav: [],
  quickActions: [],
  sensitiveFields: ['supplier_price'],
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
  EXPENSES,
  RUNNING_COSTS,
  FILES,
  COST_ENGINE,
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
