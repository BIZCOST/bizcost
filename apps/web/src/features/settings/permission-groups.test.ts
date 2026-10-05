import { hasMessage, LOCALES } from '@bizcost/i18n'
import { PERMISSION_CATALOG, type PermissionKey } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import {
  groupTitleKey,
  isSwitchOn,
  offeredSensitiveSwitches,
  permissionGroups,
  permissionHintKey,
  permissionLabelKey,
  permissionLabelKeys,
  sensitiveHintKey,
  sensitiveLabelKey,
  switchPermission,
  switchSensitive,
  visiblePermissionGroups,
} from './permission-groups'

describe('permission groups of the Roles section', () => {
  it('list every catalog key once, the dashboard first and private data last', () => {
    const groups = permissionGroups()
    expect(groups.map((g) => g.id)).toEqual([
      'dashboard',
      'business',
      'team',
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
      'running_costs',
      'cost_engine',
      'sales',
      'reports',
      'data',
    ])
    expect(groups.flatMap((g) => g.keys).sort()).toEqual([...PERMISSION_CATALOG].sort())
    expect(groups.find((g) => g.id === 'team')?.keys).toEqual([
      'settings.members.view',
      'settings.members.manage',
      'settings.roles.manage',
    ])
  })

  it('give a released module its own group, before private data', () => {
    const catalog = [...PERMISSION_CATALOG, 'orders.order.view'] as PermissionKey[]
    expect(permissionGroups(catalog).map((g) => g.id)).toEqual([
      'dashboard',
      'business',
      'team',
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
      'running_costs',
      'cost_engine',
      'sales',
      'reports',
      'orders',
      'data',
    ])
    expect(groupTitleKey('orders')).toBe('modules.orders.name')
  })

  it('have a label and a hint for every permission and a title for every group, in both languages', () => {
    for (const locale of LOCALES) {
      for (const key of PERMISSION_CATALOG) {
        expect(hasMessage(locale, permissionLabelKey(key)), `${locale} ${key}`).toBe(true)
        expect(hasMessage(locale, permissionHintKey(key)), `${locale} ${key}`).toBe(true)
      }
      for (const group of permissionGroups()) {
        expect(hasMessage(locale, groupTitleKey(group.id)), group.id).toBe(true)
      }
    }
  })
})

describe('visiblePermissionGroups', () => {
  const M1 = ['dashboard', 'settings']

  it('leaves out private data (not in M1) and branches for a single-location business', () => {
    const single = visiblePermissionGroups({ has_team: true, multi_location: false }, M1)
    expect(single.map((g) => g.id)).toEqual(['dashboard', 'business', 'team'])
    expect(single.flatMap((g) => g.keys)).not.toContain('settings.locations.manage')
    const branches = visiblePermissionGroups({ has_team: true, multi_location: true }, M1)
    expect(branches.flatMap((g) => g.keys)).toContain('settings.locations.manage')
    expect(branches.flatMap((g) => g.keys).some((key) => key.startsWith('data.'))).toBe(false)
  })

  it('offers a module’s permissions only while the module is released and on (D-124)', () => {
    const capabilities = { has_team: true, multi_location: false }
    // Products & Services and Materials are still being built: nothing of them in M1.
    expect(visiblePermissionGroups(capabilities, M1).map((g) => g.id)).not.toContain('products')
    const withModules = visiblePermissionGroups(capabilities, [...M1, 'products', 'materials'])
    expect(withModules.map((g) => g.id)).toEqual([
      'dashboard',
      'business',
      'team',
      'products',
      'materials',
    ])
    expect(withModules.find((g) => g.id === 'materials')?.keys).toEqual([
      'materials.items.view',
      'materials.items.manage',
    ])
    // Choosing whether expenses need approval only means something with a team (D-164).
    const expenses = (has_team: boolean) =>
      visiblePermissionGroups({ has_team, multi_location: false }, [...M1, 'expenses']).find(
        (g) => g.id === 'expenses',
      )?.keys
    expect(expenses(true)).toContain('expenses.approval.manage')
    expect(expenses(false)).not.toContain('expenses.approval.manage')
    expect(expenses(false)).toContain('expenses.documents.approve')
    // A module the business turned off offers nothing either.
    expect(
      visiblePermissionGroups(capabilities, [...M1, 'products']).map((g) => g.id),
    ).not.toContain('materials')
  })

  it('offers closing the books under business settings with Purchases or Expenses on (D-201)', () => {
    const capabilities = { has_team: true, multi_location: false }
    const business = (modules: string[]) =>
      visiblePermissionGroups(capabilities, [...M1, ...modules]).find((g) => g.id === 'business')
        ?.keys
    expect(business([])).not.toContain('settings.books.close')
    expect(business(['products'])).not.toContain('settings.books.close')
    expect(business(['purchases'])).toContain('settings.books.close')
    expect(business(['expenses'])).toContain('settings.books.close')
    expect(
      visiblePermissionGroups(capabilities, [...M1, 'purchases'])
        .find((g) => g.id === 'purchases')
        ?.keys.some((key) => key.includes('books')),
    ).toBe(false)
  })
})

describe('switchPermission', () => {
  it('turns on what a permission needs, and off what needs it', () => {
    const on = switchPermission(new Set(), 'settings.business.edit', true)
    expect([...on].sort()).toEqual(['settings.business.edit', 'settings.business.view'])
    expect([...switchPermission(on, 'settings.business.view', false)]).toEqual([])
    const members = switchPermission(
      new Set(['settings.members.view']),
      'settings.members.manage',
      true,
    )
    expect(switchPermission(members, 'settings.members.view', false).size).toBe(0)
    expect([...switchPermission(new Set(['data.cost.view']), 'data.cost.view', false)]).toEqual([])
  })

  it('follows what a permission needs through every step (D-155)', () => {
    const recipes = switchPermission(new Set(), 'products.recipes.manage', true)
    expect([...recipes].sort()).toEqual([
      'materials.items.view',
      'products.items.view',
      'products.recipes.manage',
      'products.recipes.view',
    ])
    // Materials off takes recipes off, and changing them with it.
    expect([...switchPermission(recipes, 'materials.items.view', false)]).toEqual([
      'products.items.view',
    ])
    expect(switchPermission(recipes, 'products.items.view', false)).toEqual(
      new Set(['materials.items.view']),
    )
  })
})

describe('the sensitive-data section (M2 Step 7, D-190)', () => {
  const costs = offeredSensitiveSwitches(['dashboard', 'settings', 'products'])

  it('offers "See costs, supplier prices and margins" once a Costing Core module is on', () => {
    expect(offeredSensitiveSwitches(['dashboard', 'settings'])).toEqual([])
    expect(costs.map((s) => s.id)).toEqual(['costs'])
    expect(offeredSensitiveSwitches(['expenses']).map((s) => s.id)).toEqual(['costs'])
    for (const locale of LOCALES) {
      for (const item of costs) {
        expect(hasMessage(locale, sensitiveLabelKey(item))).toBe(true)
        expect(hasMessage(locale, sensitiveHintKey(item))).toBe(true)
      }
    }
    // Payroll and personal details wait for the module that shows them (Phase 5).
    expect(costs.map((s) => s.id)).not.toContain('payroll')
  })

  it('switches costs, supplier prices and margins together, and only together', () => {
    const [item] = costs
    const on = switchSensitive(new Set(['products.items.view']), item!, true)
    expect([...on].sort()).toEqual([
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
      'products.items.view',
    ])
    expect(isSwitchOn(on, item!)).toBe(true)
    // One of them alone (a role saved before the release) reads as off.
    expect(isSwitchOn(new Set(['data.cost.view']), item!)).toBe(false)
    expect([...switchSensitive(on, item!, false)]).toEqual(['products.items.view'])
    // Switching one of its keys off alone takes the others with it.
    expect([...switchPermission(on, 'data.profit_margin.view', false)]).toEqual([
      'products.items.view',
    ])
  })

  it('names a set of permissions as the editors switch them', () => {
    expect(
      permissionLabelKeys([
        'data.supplier_price.view',
        'dashboard.home.view',
        'data.cost.view',
        'data.profit_margin.view',
      ]),
    ).toEqual(['settings.permissionLabels.dashboard_home_view', 'settings.sensitive.costs.label'])
    expect(permissionLabelKeys(['data.cost.view'])).toEqual([
      'settings.permissionLabels.data_cost_view',
    ])
    expect(permissionLabelKeys(['data.payroll.view'])).toEqual([
      'settings.permissionLabels.data_payroll_view',
    ])
  })
})
