import type { NavEntryDto, QuickActionDto } from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { CapabilityKey } from './capabilities'

// Module manifests (docs/ARCHITECTURE.md §Modules): the single source for navigation, "+" actions,
// Smart Setup, API guards and Customize BizCost. Every module of PRODUCT.md §7 has one line here.
// Planned modules carry no permission keys, nav or actions: those arrive when the module is built.

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

export type ModuleKind = 'core' | 'optional'
export type ModuleAvailability = 'released' | 'planned'

/** A navigation entry. Without `permission` every member of the business sees it. */
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
  nav: [{ id: 'settings', labelKey: 'nav.settings', path: 'settings', icon: 'settings' }],
  quickActions: [],
  sensitiveFields: [],
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

// Same order as MODULE_IDS. deps/requiresCapabilities follow PRODUCT.md §5–§7 and are reviewed when
// each module is built.
export const MODULES = [
  DASHBOARD,
  SETTINGS,
  planned('products', 'core', 2),
  planned('materials', 'core', 2),
  planned('suppliers', 'core', 2),
  planned('purchases', 'core', 2),
  planned('expenses', 'core', 2),
  planned('running_costs', 'core', 2),
  planned('files', 'core', 2),
  planned('cost_engine', 'core', 2),
  planned('customers', 'core', 3),
  planned('sales', 'core', 3),
  planned('payments', 'core', 3),
  planned('reports', 'core', 3),
  planned('orders', 'optional', 3),
  planned('quotations', 'optional', 3),
  planned('invoices', 'optional', 3),
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
  planned('projects', 'optional', 5),
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
