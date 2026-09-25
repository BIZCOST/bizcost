import { hasMessage, LOCALES } from '@bizcost/i18n'
import { PERMISSION_CATALOG, type PermissionKey } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import {
  groupTitleKey,
  permissionGroups,
  permissionHintKey,
  permissionLabelKey,
  switchPermission,
  visiblePermissionGroups,
} from './permission-groups'

describe('permission groups of the Roles section', () => {
  it('list every catalog key once, the dashboard first and private data last', () => {
    const groups = permissionGroups()
    expect(groups.map((g) => g.id)).toEqual(['dashboard', 'business', 'team', 'data'])
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
  it('leaves out private data (not in M1) and branches for a single-location business', () => {
    const single = visiblePermissionGroups({ has_team: true, multi_location: false })
    expect(single.map((g) => g.id)).toEqual(['dashboard', 'business', 'team'])
    expect(single.flatMap((g) => g.keys)).not.toContain('settings.locations.manage')
    const branches = visiblePermissionGroups({ has_team: true, multi_location: true })
    expect(branches.flatMap((g) => g.keys)).toContain('settings.locations.manage')
    expect(branches.flatMap((g) => g.keys).some((key) => key.startsWith('data.'))).toBe(false)
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
})
