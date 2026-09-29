import { can, OWNER_TEMPLATE_KEY, resolveEffective } from '@bizcost/domain'
import {
  buildModuleNav,
  moduleById,
  MODULES,
  PERMISSION_CATALOG,
  releasedModules,
  roleTemplateByKey,
  withPreviewModules,
  type ModuleManifest,
} from '@bizcost/modules'
import { hasMessage, terminologyKey, type I18nKey } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import {
  bottomTabs,
  businessSubpath,
  moduleAccess,
  navSlots,
  shellNav,
  shellQuickActions,
  TAB_SLOTS,
  wayBack,
  type ShellNavItem,
} from './nav'
import { FALLBACK_NAV_ICON, navIcon } from './nav-icons'

// The shell's navigation comes only from business.context's modules (D-089). Each test builds that
// part of the context the way the API does (buildModuleNav), from the registry or from a registry
// where a module was released: the shell needs no change for it.

const ID = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
const ROOT = `/b/${ID}`

function canFor(templateKey: string) {
  const effective = resolveEffective({
    roleTemplateKey: templateKey,
    rolePermissionKeys: roleTemplateByKey(templateKey)?.permissionKeys ?? [],
    overrides: [],
    catalog: PERMISSION_CATALOG,
  })
  return (key: string) => can(effective, key)
}

const owner = canFor(OWNER_TEMPLATE_KEY)
const nothing = new Set<string>()

/** Orders, released: a nav entry that needs its permission, and a "+" action. */
const ORDERS: ModuleManifest = {
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
  quickActions: [{ id: 'orders.new', labelKey: 'nav.newOrder', path: 'orders/new', icon: 'plus' }],
}

function released(...manifests: ModuleManifest[]): readonly ModuleManifest[] {
  const byId = new Map(manifests.map((m) => [m.id, m]))
  return MODULES.map((m) => byId.get(m.id) ?? m)
}

/** A planned module of the registry, released with one main entry. */
function releasedAs(id: string): ModuleManifest {
  return {
    ...moduleById(id)!,
    availability: 'released',
    nav: [{ id, labelKey: `nav.${id}`, path: id.replace(/_/g, '-'), icon: id, group: 'main' }],
  }
}

const labels = (items: readonly ShellNavItem[]) => items.map((item) => item.id)
const active = (items: readonly ShellNavItem[]) => items.find((item) => item.active)?.id

describe('shellNav with the M1 registry', () => {
  it('gives every member Dashboard and Settings, Settings last', () => {
    for (const template of [OWNER_TEMPLATE_KEY, 'manager', 'employee']) {
      const items = shellNav(buildModuleNav(nothing, canFor(template)), ID, ROOT)
      expect(items.map((item) => [item.id, item.href, item.icon, item.group])).toEqual([
        ['dashboard', ROOT, 'layout-dashboard', 'main'],
        ['settings', `${ROOT}/settings`, 'settings', 'system'],
      ])
      expect(items.map((item) => item.labelKey)).toEqual([
        'common.nav.dashboard',
        'common.nav.settings',
      ])
    }
  })

  it('hides the Dashboard from a role without it (Settings stays for everyone)', () => {
    const items = shellNav(
      buildModuleNav(nothing, (key) => key !== 'dashboard.home.view'),
      ID,
      `${ROOT}/settings`,
    )
    expect(labels(items)).toEqual(['settings'])
  })

  it('marks the item of the current page: the root only for the Dashboard, any Settings page', () => {
    const modules = buildModuleNav(nothing, owner)
    expect(active(shellNav(modules, ID, ROOT))).toBe('dashboard')
    expect(active(shellNav(modules, ID, `${ROOT}/`))).toBe('dashboard')
    expect(active(shellNav(modules, ID, `${ROOT}/settings`))).toBe('settings')
    expect(active(shellNav(modules, ID, `${ROOT}/settings/members`))).toBe('settings')
    expect(active(shellNav(modules, ID, `${ROOT}/settingsx`))).toBeUndefined()
    expect(active(shellNav(modules, ID, '/account'))).toBeUndefined()
  })

  it('has no "+" and no "More" tab', () => {
    const modules = buildModuleNav(nothing, owner)
    expect(shellQuickActions(modules, ID)).toEqual([])
    const tabs = bottomTabs(shellNav(modules, ID, ROOT), [])
    expect(labels(tabs.tabs)).toEqual(['dashboard', 'settings'])
    expect(tabs.more).toEqual([])
    expect(tabs.quickAdd).toBe(false)
  })
})

describe('a module released later shows with no change to the shell', () => {
  const registry = released(ORDERS)

  it('in the sidebar, the rail and the tabs, before Settings, once the business turns it on', () => {
    const on = buildModuleNav(new Set(['orders']), owner, registry)
    const items = shellNav(on, ID, `${ROOT}/orders/123`)
    expect(items.map((item) => [item.id, item.href])).toEqual([
      ['dashboard', ROOT],
      ['orders', `${ROOT}/orders`],
      ['settings', `${ROOT}/settings`],
    ])
    expect(active(items)).toBe('orders')
    expect(labels(bottomTabs(items, shellQuickActions(on, ID)).tabs)).toEqual([
      'dashboard',
      'orders',
      'settings',
    ])
    // Not turned on for this business: not there.
    expect(labels(shellNav(buildModuleNav(nothing, owner, registry), ID, ROOT))).toEqual([
      'dashboard',
      'settings',
    ])
  })

  it('only for members with its permission; its "+" action brings the "+" tab', () => {
    const on = new Set(['orders'])
    const employee = buildModuleNav(on, canFor('employee'), registry)
    expect(labels(shellNav(employee, ID, ROOT))).toEqual(['dashboard', 'settings'])
    const ownerModules = buildModuleNav(on, owner, registry)
    const actions = shellQuickActions(ownerModules, ID)
    expect(actions).toEqual([
      {
        id: 'orders.new',
        labelKey: 'common.nav.newOrder',
        href: `${ROOT}/orders/new`,
        icon: 'plus',
      },
    ])
    expect(bottomTabs(shellNav(ownerModules, ID, ROOT), actions).quickAdd).toBe(true)
  })

  it('with a neutral icon until the shell knows its icon', () => {
    expect(navIcon('shopping-bag')).toBe(FALLBACK_NAV_ICON)
    expect(navIcon('settings')).not.toBe(FALLBACK_NAV_ICON)
  })

  it('and the page states follow: off for a business without it, not open without permission', () => {
    const on = new Set(['orders'])
    expect(moduleAccess(buildModuleNav(on, owner, registry), 'orders', 'orders')).toBe('open')
    expect(moduleAccess(buildModuleNav(nothing, owner, registry), 'orders', 'orders')).toBe('off')
    expect(moduleAccess(buildModuleNav(on, canFor('employee'), registry), 'orders', 'orders')).toBe(
      'forbidden',
    )
    // Still planned in the real registry: off, whatever the business chose.
    expect(moduleAccess(buildModuleNav(on, owner), 'orders', 'orders')).toBe('off')
  })
})

describe('the modules being built (M2 Step 2), in the dev-only preview', () => {
  const registry = withPreviewModules(['products', 'materials'])
  const on = new Set(['products', 'materials'])

  it('show before Settings with their own icons, for members with their permission', () => {
    const items = shellNav(buildModuleNav(on, owner, registry), ID, `${ROOT}/materials`)
    expect(items.map((item) => [item.id, item.href])).toEqual([
      ['dashboard', ROOT],
      ['products', `${ROOT}/products`],
      ['materials', `${ROOT}/materials`],
      ['settings', `${ROOT}/settings`],
    ])
    expect(active(items)).toBe('materials')
    for (const item of items) expect(navIcon(item.icon)).not.toBe(FALLBACK_NAV_ICON)
    // Sales sees Products & Services, not Materials; an employee both, since what goes into a
    // product names its materials (PRODUCT.md §8, D-179).
    expect(labels(shellNav(buildModuleNav(on, canFor('sales'), registry), ID, ROOT))).toEqual([
      'dashboard',
      'products',
      'settings',
    ])
    expect(labels(shellNav(buildModuleNav(on, canFor('employee'), registry), ID, ROOT))).toEqual([
      'dashboard',
      'products',
      'materials',
      'settings',
    ])
    // Released code: not there, whatever the business chose.
    expect(labels(shellNav(buildModuleNav(on, owner), ID, ROOT))).toEqual(['dashboard', 'settings'])
  })

  it('are named in the business wording', () => {
    const modules = buildModuleNav(on, owner, registry)
    const wording = (profile: 'food' | 'factory' | 'projects' | 'general') => (key: I18nKey) =>
      terminologyKey(key, profile, (overlay) => hasMessage('en', overlay))
    const names = (profile: 'food' | 'factory' | 'projects' | 'general') =>
      shellNav(modules, ID, ROOT, wording(profile)).map((item) => item.labelKey)
    expect(names('food')).toContain('common.nav.materials_food')
    expect(names('factory')).toContain('common.nav.materials_factory')
    expect(names('projects')).toContain('common.nav.products_projects')
    expect(names('general')).toEqual([
      'common.nav.dashboard',
      'common.nav.products',
      'common.nav.materials',
      'common.nav.settings',
    ])
  })
})

describe('bottomTabs', () => {
  const many = ['products', 'materials', 'purchases', 'expenses', 'sales']

  it('puts what does not fit under "More", with Settings last', () => {
    const registry = released(...many.map(releasedAs))
    const items = shellNav(buildModuleNav(new Set(many), owner, registry), ID, `${ROOT}/settings`)
    expect(labels(items)).toEqual([
      'dashboard',
      'products',
      'materials',
      'purchases',
      'expenses',
      'sales',
      'settings',
    ])
    const tabs = bottomTabs(items, [])
    expect(tabs.tabs).toHaveLength(TAB_SLOTS - 1)
    expect(labels(tabs.tabs)).toEqual(['dashboard', 'products', 'materials', 'purchases'])
    expect(labels(tabs.more)).toEqual(['expenses', 'sales', 'settings'])
    expect(tabs.more.some((item) => item.active)).toBe(true)
  })

  it('keeps a place for "+" when there are actions', () => {
    const items = shellNav(buildModuleNav(nothing, owner), ID, ROOT)
    const action = { id: 'x', labelKey: 'common.nav.dashboard', href: ROOT, icon: 'plus' } as const
    const five = [...items, ...items, items[0]!]
    expect(bottomTabs(five, [action]).tabs).toHaveLength(TAB_SLOTS - 2)
    expect(bottomTabs(five.slice(0, 4), [action]).tabs).toHaveLength(4)
  })
})

describe('a page two modules share: Amounts owed (Purchases and Expenses, D-166)', () => {
  const registry = withPreviewModules(['materials', 'suppliers', 'purchases', 'expenses'])
  const both = new Set(['materials', 'suppliers', 'purchases', 'expenses'])
  const shared = ['purchases', 'expenses'] as const

  it('is listed once and open through either module; off only when neither is on', () => {
    const modules = buildModuleNav(both, owner, registry)
    const items = shellNav(modules, ID, `${ROOT}/payables`)
    expect(items.filter((item) => item.id === 'payables')).toHaveLength(1)
    expect(active(items)).toBe('payables')
    expect(moduleAccess(modules, shared, 'payables')).toBe('open')
    // A business without Purchases (it sells services) keeps it through Expenses.
    const expensesOnly = buildModuleNav(new Set(['expenses']), owner, registry)
    expect(moduleAccess(expensesOnly, shared, 'payables')).toBe('open')
    expect(moduleAccess(expensesOnly, 'purchases', 'payables')).toBe('off')
    expect(moduleAccess(buildModuleNav(nothing, owner, registry), shared, 'payables')).toBe('off')
    // On, but not open to an employee (no key to see what is owed).
    expect(
      moduleAccess(buildModuleNav(both, canFor('employee'), registry), shared, 'payables'),
    ).toBe('forbidden')
    // Unless the business owes them for something they paid themselves: "Owed to me" (D-181).
    const owedTo = buildModuleNav(both, canFor('employee'), registry, new Set(['expenses']))
    expect(moduleAccess(owedTo, shared, 'payables')).toBe('open')
    expect(labels(shellNav(owedTo, ID, ROOT)).filter((id) => id === 'payables')).toHaveLength(1)
    // Its states lead to a section of neither module.
    expect(wayBack(items, shared)?.id).toBe('dashboard')
    for (const item of items) expect(navIcon(item.icon)).not.toBe(FALLBACK_NAV_ICON)
  })

  it('owed for a purchase, an employee keeps Expenses in the phone bar; Amounts owed goes to More (D-184)', () => {
    const on = new Set(['products', 'materials', 'suppliers', 'purchases', 'expenses'])
    const catalog = withPreviewModules([
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
    ])
    const before = shellNav(buildModuleNav(on, canFor('employee'), catalog), ID, ROOT)
    expect(labels(before)).toEqual(['dashboard', 'products', 'materials', 'expenses', 'settings'])
    const owedTo = buildModuleNav(on, canFor('employee'), catalog, new Set(['purchases']))
    const items = shellNav(owedTo, ID, ROOT)
    // After everything the employee reaches by their keys, open through either module.
    expect(labels(items)).toEqual([
      'dashboard',
      'products',
      'materials',
      'expenses',
      'payables',
      'settings',
    ])
    expect(moduleAccess(owedTo, shared, 'payables')).toBe('open')
    const bar = bottomTabs(items, [])
    expect(bar.tabs.map((item) => item.id)).toEqual([
      'dashboard',
      'products',
      'materials',
      'expenses',
    ])
    expect(bar.more.map((item) => item.id)).toEqual(['payables', 'settings'])
  })
})

describe('wayBack', () => {
  it("leads from a module's state to another section: the first in the nav, else Settings", () => {
    const registry = released(ORDERS)
    const items = shellNav(buildModuleNav(new Set(['orders']), owner, registry), ID, ROOT)
    expect(wayBack(items, 'orders')?.id).toBe('dashboard')
    expect(wayBack(items, 'dashboard')?.id).toBe('orders')
    // Without the Dashboard: the business root sends the member to Settings.
    const noDashboard = shellNav(
      buildModuleNav(nothing, (key) => key !== 'dashboard.home.view'),
      ID,
      ROOT,
    )
    expect(wayBack(noDashboard, 'dashboard')?.href).toBe(`${ROOT}/settings`)
    expect(wayBack([], 'dashboard')).toBeUndefined()
  })
})

describe('navSlots: the placeholder while a business loads', () => {
  it('has a place for each released entry, by group', () => {
    expect(navSlots(releasedModules())).toEqual({ main: 1, system: 1 })
    expect(navSlots(released(ORDERS).filter((m) => m.availability === 'released'))).toEqual({
      main: 2,
      system: 1,
    })
  })
})

describe('businessSubpath', () => {
  it('reads the path below the business root', () => {
    expect(businessSubpath(ROOT, ID)).toBe('')
    expect(businessSubpath(`${ROOT}/settings/members?x=1`, ID)).toBe('settings/members')
    expect(businessSubpath(`/b/${ID}0/settings`, ID)).toBeNull()
    expect(businessSubpath('/setup', ID)).toBeNull()
  })
})

describe('Product costs (the Cost Engine, M2 Step 6), in the dev-only preview', () => {
  const registry = withPreviewModules(['products', 'materials', 'running_costs', 'cost_engine'])
  const on = new Set(['products', 'materials', 'running_costs', 'cost_engine'])

  it('shows after the costing sections with its own icon, active on a product breakdown', () => {
    const items = shellNav(
      buildModuleNav(on, owner, registry),
      ID,
      `${ROOT}/product-costs/0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f71`,
    )
    expect(labels(items)).toEqual([
      'dashboard',
      'products',
      'materials',
      'running_costs',
      'product_costs',
      'settings',
    ])
    expect(active(items)).toBe('product_costs')
    for (const item of items) expect(navIcon(item.icon)).not.toBe(FALLBACK_NAV_ICON)
    expect(moduleAccess(buildModuleNav(on, owner, registry), 'cost_engine', 'product_costs')).toBe(
      'open',
    )
  })

  it('is open to the templates that see product costs; Sales, Supervisor and Employee get none', () => {
    const access = (template: string) =>
      moduleAccess(buildModuleNav(on, canFor(template), registry), 'cost_engine', 'product_costs')
    expect(access('admin')).toBe('open')
    expect(access('manager')).toBe('open')
    expect(access('accountant')).toBe('open')
    for (const template of ['sales', 'supervisor', 'employee']) {
      expect(access(template), template).toBe('forbidden')
    }
    // Off for a business without it, and still planned in the released code.
    expect(
      moduleAccess(
        buildModuleNav(new Set(['products']), owner, registry),
        'cost_engine',
        'product_costs',
      ),
    ).toBe('off')
    expect(moduleAccess(buildModuleNav(on, owner), 'cost_engine', 'product_costs')).toBe('off')
  })
})
