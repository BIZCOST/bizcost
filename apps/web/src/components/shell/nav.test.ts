import { can, OWNER_TEMPLATE_KEY, resolveEffective } from '@bizcost/domain'
import {
  buildModuleNav,
  moduleById,
  MODULES,
  PERMISSION_CATALOG,
  releasedModules,
  roleTemplateByKey,
  type ModuleManifest,
} from '@bizcost/modules'
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
