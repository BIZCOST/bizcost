import { can, OWNER_TEMPLATE_KEY, resolveEffective } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  DERIVED_CAPABILITY_KEYS,
  isStoredCapabilityKey,
  resolveCapabilities,
  STORED_CAPABILITY_KEYS,
} from './capabilities'
import { MODULES, type ModuleManifest } from './manifests'
import {
  isCatalogPermissionKey,
  keysMissingNeeds,
  offeredSensitiveDataSwitches,
  PERMISSION_CATALOG,
  PERMISSION_NEEDS,
  SENSITIVE_DATA_SWITCHES,
  withNeededKeys,
} from './permissions'
import { isRoleTemplateKey, ROLE_TEMPLATES, roleTemplateByKey } from './role-templates'
import {
  buildModuleNav,
  isModuleActive,
  isModuleEnabled,
  isModuleReleased,
  isModuleVisible,
  moduleById,
  parsePreviewModules,
  PREVIEWABLE_MODULE_IDS,
  releasedModules,
  resolveEnabledModules,
  visibleNav,
  withPreviewModules,
} from './registry'

const NONE = new Set<string>()
const nobody = () => false
const everybody = () => true

function canFor(templateKey: string) {
  const template = roleTemplateByKey(templateKey)
  const effective = resolveEffective({
    roleTemplateKey: templateKey,
    rolePermissionKeys: template?.permissionKeys ?? [],
    overrides: [],
    catalog: PERMISSION_CATALOG,
  })
  return (key: string) => can(effective, key)
}

const dashboard = moduleById('dashboard')!
const settings = moduleById('settings')!
const orders = moduleById('orders')!

describe('lookups', () => {
  it('moduleById finds manifests and returns undefined for unknown ids', () => {
    expect(dashboard.id).toBe('dashboard')
    expect(moduleById('data')).toBeUndefined()
    expect(moduleById('')).toBeUndefined()
  })

  it('releasedModules lists released manifests in manifest order', () => {
    expect(releasedModules().map((m) => m.id)).toEqual([
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
    ])
    expect(releasedModules().every(isModuleReleased)).toBe(true)
  })

  it('isCatalogPermissionKey accepts catalog keys only', () => {
    expect(isCatalogPermissionKey('settings.roles.manage')).toBe(true)
    expect(isCatalogPermissionKey('data.cost.view')).toBe(true)
    expect(isCatalogPermissionKey('settings.ownership.transfer')).toBe(false)
    expect(isCatalogPermissionKey(undefined)).toBe(false)
  })

  it('PERMISSION_NEEDS pairs catalog keys, and every role template is coherent', () => {
    for (const [key, needed] of Object.entries(PERMISSION_NEEDS)) {
      expect(isCatalogPermissionKey(key), key).toBe(true)
      for (const n of needed ?? []) expect(isCatalogPermissionKey(n), n).toBe(true)
    }
    for (const template of ROLE_TEMPLATES) {
      expect(keysMissingNeeds(template.permissionKeys), template.key).toEqual([])
    }
    expect(keysMissingNeeds(['settings.business.edit', 'settings.members.manage'])).toEqual([
      'settings.business.edit',
      'settings.members.manage',
    ])
    expect(keysMissingNeeds(['settings.members.manage', 'settings.members.view'])).toEqual([])
    // Seeing what goes into each product needs its materials too (D-155).
    expect(keysMissingNeeds(['products.items.view', 'products.recipes.view'])).toEqual([
      'products.recipes.view',
    ])
    expect(
      keysMissingNeeds(['products.items.view', 'materials.items.view', 'products.recipes.view']),
    ).toEqual([])
    // Costs, supplier prices and margins are granted only together (D-144, D-187).
    expect(keysMissingNeeds(['data.cost.view', 'data.supplier_price.view'])).toEqual([
      'data.cost.view',
    ])
    expect(keysMissingNeeds(['data.profit_margin.view'])).toEqual(['data.profit_margin.view'])
    expect(keysMissingNeeds(['data.supplier_price.view'])).toEqual(['data.supplier_price.view'])
    expect(
      keysMissingNeeds(['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view']),
    ).toEqual([])
    expect(keysMissingNeeds(['data.payroll.view'])).toEqual([])
  })

  it('withNeededKeys takes out, until nothing changes, every key that misses a key it needs', () => {
    const effective = (keys: string[]) =>
      withNeededKeys(
        resolveEffective({
          roleTemplateKey: 'custom',
          rolePermissionKeys: keys,
          overrides: [],
          catalog: PERMISSION_CATALOG,
        }),
      )
    // A chain: product costs need recipes, which need materials; without materials none stands.
    expect([
      ...effective([
        'products.items.view',
        'products.recipes.view',
        'cost_engine.product_costs.view',
        'cost_engine.settings.manage',
      ]).keys,
    ]).toEqual(['products.items.view'])
    // One data key alone of the three grants nothing; payroll stands alone.
    expect([...effective(['data.cost.view', 'data.payroll.view']).keys]).toEqual([
      'data.payroll.view',
    ])
    const whole = resolveEffective({
      roleTemplateKey: 'manager',
      rolePermissionKeys: roleTemplateByKey('manager')!.permissionKeys,
      overrides: [],
      catalog: PERMISSION_CATALOG,
    })
    expect(withNeededKeys(whole)).toBe(whole)
    const owner = resolveEffective({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: [],
      overrides: [{ key: 'data.cost.view', effect: 'deny' }],
      catalog: PERMISSION_CATALOG,
    })
    expect(withNeededKeys(owner)).toBe(owner)
  })

  it('offers costs, supplier prices and margins as one sensitive-data switch, with a module that shows them on', () => {
    expect(SENSITIVE_DATA_SWITCHES.map((s) => [s.id, [...s.keys]])).toEqual([
      ['costs', ['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view']],
      ['payroll', ['data.payroll.view']],
      ['employee_pii', ['data.employee_pii.view']],
    ])
    // Each data key is in exactly one switch, and a switch holds every key its keys need.
    const keys = SENSITIVE_DATA_SWITCHES.flatMap((s) => s.keys)
    expect([...keys].sort()).toEqual(PERMISSION_CATALOG.filter((k) => k.startsWith('data.')).sort())
    for (const s of SENSITIVE_DATA_SWITCHES) expect(keysMissingNeeds(s.keys), s.id).toEqual([])
    expect(offeredSensitiveDataSwitches(['dashboard', 'settings']).map((s) => s.id)).toEqual([])
    expect(offeredSensitiveDataSwitches(['dashboard', 'expenses']).map((s) => s.id)).toEqual([
      'costs',
    ])
    expect(
      offeredSensitiveDataSwitches(MODULES.map((m) => m.id)).map((s) => s.id),
      'payroll and personal data come with the modules that show them (Phase 5)',
    ).toEqual(['costs'])
  })

  it('isRoleTemplateKey / roleTemplateByKey', () => {
    expect(isRoleTemplateKey(OWNER_TEMPLATE_KEY)).toBe(true)
    expect(isRoleTemplateKey('Owner')).toBe(false)
    expect(roleTemplateByKey('manager')?.key).toBe('manager')
    expect(roleTemplateByKey('custom')).toBeUndefined()
  })
})

describe('module gates', () => {
  it('keeps Dashboard and Settings always enabled, without rows', () => {
    expect(isModuleEnabled(dashboard, NONE)).toBe(true)
    expect(isModuleEnabled(settings, NONE)).toBe(true)
  })

  it('enables other modules only when the resolved set holds them', () => {
    expect(isModuleEnabled(orders, NONE)).toBe(false)
    expect(isModuleEnabled(orders, new Set(['orders']))).toBe(true)
  })

  it('never activates a planned module, even when the business enabled it', () => {
    const enabled = new Set(MODULES.map((m) => m.id))
    expect(isModuleActive(orders, enabled)).toBe(false)
    expect(isModuleVisible(orders, enabled, everybody)).toBe(false)
    expect(isModuleActive(dashboard, NONE)).toBe(true)
  })

  it('shows a released module only when a nav entry is permitted', () => {
    expect(isModuleVisible(dashboard, NONE, everybody)).toBe(true)
    expect(isModuleVisible(dashboard, NONE, nobody)).toBe(false)
    // Settings holds every member's own profile and language: no permission needed.
    expect(isModuleVisible(settings, NONE, nobody)).toBe(true)
  })

  it('filters nav entries by permission', () => {
    expect(visibleNav(dashboard, nobody)).toEqual([])
    expect(visibleNav(dashboard, (k) => k === 'dashboard.home.view').map((e) => e.id)).toEqual([
      'dashboard',
    ])
  })
})

describe('the dev-only preview (D-125)', () => {
  // No module is being built between M2 Step 7 and Phase 3: a test registry starts the build of Orders
  // (its keys and nav) while it stays planned.
  const building: ModuleManifest = {
    ...orders,
    permissionKeys: ['orders.view'],
    nav: [
      {
        id: 'orders',
        labelKey: 'nav.orders',
        path: 'orders',
        icon: 'shopping-bag',
        group: 'main',
        permission: 'orders.view',
      },
    ],
  }
  const registry = MODULES.map((m) => (m.id === 'orders' ? building : m))
  const ordersOn = resolveEnabledModules([{ key: 'orders', enabled: true }])

  it('may show only planned modules whose build started: Sales since M3 Step 2, Reports since Step 3', () => {
    expect(PREVIEWABLE_MODULE_IDS).toEqual(['sales', 'reports'])
  })

  it('parses a comma or space separated list, ignores released modules, and names what it cannot preview', () => {
    expect(parsePreviewModules(undefined, registry)).toEqual({ ids: [], released: [], invalid: [] })
    expect(parsePreviewModules('  ', registry)).toEqual({ ids: [], released: [], invalid: [] })
    expect(parsePreviewModules(' orders , orders', registry)).toEqual({
      ids: ['orders'],
      released: [],
      invalid: [],
    })
    // A list written before the Costing Core's release (a local server's environment): its modules
    // are released now, so there is nothing to preview and the server keeps starting.
    expect(parsePreviewModules('materials,products', registry)).toEqual({
      ids: [],
      released: ['products', 'materials'],
      invalid: [],
    })
    // Unknown, or planned without a build: refused by name.
    expect(parsePreviewModules('orders,quotations,Orders,nope', registry)).toEqual({
      ids: ['orders'],
      released: [],
      invalid: ['quotations', 'Orders', 'nope'],
    })
    // The real registry has nothing to preview.
    expect(parsePreviewModules('orders,materials')).toEqual({
      ids: [],
      released: ['materials'],
      invalid: ['orders'],
    })
  })

  it('counts the named modules as released, and nothing else', () => {
    const previewed = withPreviewModules(['orders', 'quotations'], registry)
    expect(
      isModuleActive(
        previewed.find((m) => m.id === 'orders')!,
        ordersOn,
      ),
    ).toBe(true)
    expect(previewed.find((m) => m.id === 'quotations')?.availability).toBe('planned')
    // The registry passed in is untouched.
    expect(building.availability).toBe('planned')
    expect(isModuleActive(building, ordersOn)).toBe(false)
    expect(withPreviewModules([], registry)).toBe(registry)
    // With the real registry nothing changes.
    expect(withPreviewModules(['orders', 'materials'])).toBe(MODULES)
  })

  it('still needs the business to have the module on and the member its permission', () => {
    const previewed = withPreviewModules(['orders'], registry)
    const entries = (enabled: ReadonlySet<string>, can: (key: string) => boolean) =>
      buildModuleNav(enabled, can, previewed)
        .find((m) => m.id === 'orders')
        ?.nav.map((e) => e.id)
    expect(entries(ordersOn, everybody)).toEqual(['orders'])
    expect(entries(ordersOn, (key) => key !== 'orders.view')).toEqual([])
    // An optional module is off until the business turns it on.
    expect(entries(resolveEnabledModules([]), everybody)).toBeUndefined()
  })
})

describe('the Costing Core, released (M2 Step 7)', () => {
  const core = resolveEnabledModules([])
  const entries = (enabled: ReadonlySet<string>, can: (key: string) => boolean) =>
    buildModuleNav(enabled, can).map((m): [string, string[]] => [m.id, m.nav.map((e) => e.id)])
  const plus = (enabled: ReadonlySet<string>, can: (key: string) => boolean) =>
    buildModuleNav(enabled, can).flatMap((m) => m.quickActions.map((a) => a.id))

  it('shows without the preview: the owner gets every section and "+" for a product, a purchase and an expense', () => {
    expect(entries(core, canFor(OWNER_TEMPLATE_KEY))).toEqual([
      ['dashboard', ['dashboard']],
      ['settings', ['settings']],
      ['products', ['products']],
      ['materials', ['materials']],
      ['suppliers', ['suppliers']],
      ['purchases', ['purchases', 'payables']],
      ['expenses', ['expenses']],
      ['running_costs', ['running_costs']],
      ['files', []],
      ['cost_engine', ['product_costs']],
    ])
    expect(plus(core, canFor(OWNER_TEMPLATE_KEY))).toEqual([
      'new_product',
      'new_purchase',
      'new_expense',
    ])
  })

  it('is still gated by the module being on and the permission of the member', () => {
    // An employee: what goes into products, their materials, and entering expenses (D-179, D-180).
    expect(entries(core, canFor('employee')).filter(([, ids]) => ids.length > 0)).toEqual([
      ['dashboard', ['dashboard']],
      ['settings', ['settings']],
      ['products', ['products']],
      ['materials', ['materials']],
      ['expenses', ['expenses']],
    ])
    expect(plus(core, canFor('employee'))).toEqual(['new_expense'])
    expect(plus(core, canFor('sales'))).toEqual([])
    expect(plus(core, canFor('accountant'))).toEqual([])
    // Turned off by the business (a services business without Purchases and Materials): gone.
    const off = resolveEnabledModules([
      { key: 'purchases', enabled: false },
      { key: 'materials', enabled: false },
    ])
    expect(entries(off, canFor(OWNER_TEMPLATE_KEY)).map(([id]) => id)).not.toContain('purchases')
    expect(plus(off, canFor(OWNER_TEMPLATE_KEY))).toEqual(['new_product', 'new_expense'])
  })

  it('claims phone tabs so that an owner keeps Product costs and an employee Expenses', () => {
    const tabs = (can: (key: string) => boolean) =>
      buildModuleNav(core, can)
        .flatMap((m) => m.nav)
        .map((e) => [e.id, e.tab])
    expect(tabs(canFor(OWNER_TEMPLATE_KEY))).toEqual([
      ['dashboard', 1],
      ['settings', null],
      ['products', 4],
      ['materials', 7],
      ['suppliers', null],
      ['purchases', 6],
      ['payables', null],
      ['expenses', 5],
      ['running_costs', null],
      ['product_costs', 3],
    ])
  })
})

describe('resolveEnabledModules', () => {
  const core = MODULES.filter((m) => m.kind === 'core').map((m) => m.id)

  it('turns every core module on without rows, and no optional module', () => {
    expect([...resolveEnabledModules([])]).toEqual(core)
    expect(core).toContain('materials')
    expect(core).not.toContain('orders')
  })

  it('lets a row switch a core module off and an optional module on', () => {
    const enabled = resolveEnabledModules([
      { key: 'materials', enabled: false },
      { key: 'orders', enabled: true },
      { key: 'inventory', enabled: false },
    ])
    expect(enabled.has('materials')).toBe(false)
    expect(enabled.has('products')).toBe(true)
    expect(enabled.has('orders')).toBe(true)
    expect(enabled.has('inventory')).toBe(false)
  })

  it('keeps Dashboard and Settings on whatever their rows say, and ignores unknown keys', () => {
    const enabled = resolveEnabledModules([
      { key: 'dashboard', enabled: false },
      { key: 'settings', enabled: false },
      { key: 'no_such_module', enabled: true },
    ])
    expect(enabled.has('dashboard')).toBe(true)
    expect(enabled.has('settings')).toBe(true)
    expect(enabled.has('no_such_module' as never)).toBe(false)
  })
})

describe('buildModuleNav', () => {
  it('lists released + enabled modules with the entries the member may use', () => {
    const nav = buildModuleNav(new Set(['orders', 'inventory']), canFor('employee'))
    expect(nav).toEqual([
      {
        id: 'dashboard',
        nav: [
          {
            id: 'dashboard',
            labelKey: 'nav.dashboard',
            path: '',
            icon: 'layout-dashboard',
            group: 'main',
            tab: 1,
          },
        ],
        quickActions: [],
      },
      {
        id: 'settings',
        nav: [
          {
            id: 'settings',
            labelKey: 'nav.settings',
            path: 'settings',
            icon: 'settings',
            group: 'system',
            tab: null,
          },
        ],
        quickActions: [],
      },
    ])
  })

  it('keeps an enabled module whose entries are all hidden, with an empty nav', () => {
    const nav = buildModuleNav(NONE, nobody)
    expect(nav.map((m) => [m.id, m.nav.length])).toEqual([
      ['dashboard', 0],
      ['settings', 1],
    ])
  })

  it('gives the owner every entry', () => {
    const nav = buildModuleNav(NONE, canFor(OWNER_TEMPLATE_KEY))
    expect(nav.flatMap((m) => m.nav.map((e) => e.id))).toEqual(['dashboard', 'settings'])
  })

  it('adds a module once it is released, only for businesses that turned it on', () => {
    const released: ModuleManifest = {
      ...moduleById('orders')!,
      availability: 'released',
      nav: [
        {
          id: 'orders',
          labelKey: 'nav.orders',
          path: 'orders',
          icon: 'shopping-bag',
          group: 'main',
          permission: 'orders.view',
        },
      ],
      quickActions: [
        { id: 'orders.new', labelKey: 'nav.newOrder', path: 'orders/new', icon: 'plus' },
      ],
    }
    const registry = MODULES.map((m) => (m.id === 'orders' ? released : m))
    const ids = (enabled: Set<string>, can: (key: string) => boolean) =>
      buildModuleNav(enabled, can, registry).map((m) => [m.id, m.nav.length, m.quickActions.length])
    expect(ids(new Set(['orders']), everybody)).toEqual([
      ['dashboard', 1, 0],
      ['settings', 1, 0],
      ['orders', 1, 1],
    ])
    expect(ids(NONE, everybody)).toEqual([
      ['dashboard', 1, 0],
      ['settings', 1, 0],
    ])
    // Without the permission the module stays listed, with no entries (the shell hides it).
    expect(ids(new Set(['orders']), (key) => key !== 'orders.view')).toContainEqual([
      'orders',
      0,
      1,
    ])
  })

  it('lists a page two modules share (Amounts owed, D-166) once, through the first the member may use', () => {
    const registry: readonly ModuleManifest[] = MODULES
    const entries = (enabled: Set<string>, can: (key: string) => boolean) =>
      buildModuleNav(enabled, can, registry).map((m) => [m.id, m.nav.map((e) => e.id)])
    // Core modules are on unless switched off.
    const all = new Set(['purchases', 'expenses'])
    expect(entries(all, everybody)).toEqual([
      ['dashboard', ['dashboard']],
      ['settings', ['settings']],
      ['purchases', ['purchases', 'payables']],
      ['expenses', ['expenses']],
    ])
    // Only the expenses' payments: the page comes with Expenses.
    const expensesOnly = (key: string) => !key.startsWith('purchases.payments')
    expect(entries(all, expensesOnly)).toContainEqual(['expenses', ['expenses', 'payables']])
    expect(entries(all, expensesOnly)).toContainEqual(['purchases', ['purchases']])
    // Purchases turned off (a services business): the page stays, with Expenses.
    const noPurchases = buildModuleNav(
      resolveEnabledModules([{ key: 'purchases', enabled: false }]),
      everybody,
      registry,
    )
    expect(noPurchases.map((m) => [m.id, m.nav.map((e) => e.id)])).toContainEqual([
      'expenses',
      ['expenses', 'payables'],
    ])
    expect(noPurchases.some((m) => m.id === 'purchases')).toBe(false)
  })

  it('shows "Amounts owed" to a member it owes, without its keys, once (D-181)', () => {
    const registry: readonly ModuleManifest[] = MODULES
    const all = new Set(['purchases', 'expenses'])
    const employee = canFor('employee')
    const entries = (payeeIn: Set<string>, enabled: ReadonlySet<string> = all) =>
      buildModuleNav(enabled, employee, registry, payeeIn).map((m) => [
        m.id,
        m.nav.map((e) => e.id),
      ])
    // Nothing owed: no Amounts owed (the employee has no payment keys).
    expect(entries(new Set()).flatMap(([, ids]) => ids)).not.toContain('payables')
    // Owed for an expense: the entry comes with Expenses, once.
    expect(entries(new Set(['expenses']))).toContainEqual(['expenses', ['expenses', 'payables']])
    // Owed for a purchase (no Purchases keys): after Expenses, the section the employee works in,
    // so it never pushes it into the phone's "More" (D-184); listed once for both.
    expect(entries(new Set(['purchases']))).toContainEqual(['expenses', ['expenses', 'payables']])
    const both = entries(new Set(['purchases', 'expenses']))
    expect(both).toContainEqual(['purchases', []])
    expect(both).toContainEqual(['expenses', ['expenses', 'payables']])
    expect(both.flatMap(([, ids]) => ids).filter((id) => id === 'payables')).toHaveLength(1)
    // Reached by keys (a Manager), it stays with Purchases, its first module.
    const manager = buildModuleNav(all, canFor('manager'), registry, new Set(['expenses']))
    expect(manager.find((m) => m.id === 'purchases')?.nav.map((e) => e.id)).toContain('payables')
    expect(manager.find((m) => m.id === 'expenses')?.nav.map((e) => e.id)).not.toContain('payables')
    // A module turned off shows nothing for it.
    const noExpenses = resolveEnabledModules([{ key: 'expenses', enabled: false }])
    expect(entries(new Set(['expenses']), noExpenses).flatMap(([, ids]) => ids)).not.toContain(
      'payables',
    )
    // Only the payables entries are for payees.
    for (const manifest of registry) {
      for (const entry of manifest.nav) {
        if (entry.payees) expect(entry.id).toBe('payables')
      }
    }
  })
})

describe('resolveCapabilities', () => {
  it('fills every capability, with defaults for missing rows', () => {
    expect(resolveCapabilities({ stored: [], derived: { vat_registered: false } })).toEqual({
      has_team: false,
      multi_location: false,
      keeps_stock: false,
      uses_machines: false,
      sells_via_pos: false,
      jobs_and_tasks: false,
      vat_registered: false,
    })
  })

  it('reads stored rows and derives vat_registered from the business', () => {
    const capabilities = resolveCapabilities({
      stored: [
        { key: 'has_team', enabled: true },
        { key: 'keeps_stock', enabled: false },
      ],
      derived: { vat_registered: true },
    })
    expect(capabilities.has_team).toBe(true)
    expect(capabilities.keeps_stock).toBe(false)
    expect(capabilities.vat_registered).toBe(true)
  })

  it('ignores unknown keys and stored rows for derived capabilities', () => {
    const capabilities = resolveCapabilities({
      stored: [
        { key: 'vat_registered', enabled: true },
        { key: 'works_alone', enabled: true },
      ],
      derived: { vat_registered: false },
    })
    expect(capabilities.vat_registered).toBe(false)
    expect('works_alone' in capabilities).toBe(false)
  })

  it('splits stored and derived keys', () => {
    expect(DERIVED_CAPABILITY_KEYS).toEqual(['vat_registered'])
    expect(STORED_CAPABILITY_KEYS).not.toContain('vat_registered')
    expect(isStoredCapabilityKey('has_team')).toBe(true)
    expect(isStoredCapabilityKey('vat_registered')).toBe(false)
  })
})
