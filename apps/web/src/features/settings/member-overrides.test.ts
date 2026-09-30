import { offeredSensitiveDataSwitches } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { changeCount, changedSwitches, overridesFor } from './member-overrides'

describe("a member's own changes (member.updatePermissions, D-191)", () => {
  const role = ['dashboard.home.view', 'products.items.view', 'materials.items.view']

  it('are only how what they may do differs from their role', () => {
    expect(overridesFor(new Set(role), role)).toEqual([])
    const wanted = new Set([
      'dashboard.home.view',
      'products.items.view',
      'data.cost.view',
      'data.supplier_price.view',
      'data.profit_margin.view',
    ])
    expect(overridesFor(wanted, role)).toEqual([
      { key: 'data.cost.view', effect: 'allow' },
      { key: 'data.profit_margin.view', effect: 'allow' },
      { key: 'data.supplier_price.view', effect: 'allow' },
      { key: 'materials.items.view', effect: 'deny' },
    ])
  })

  it('are counted as the page shows them: the costs switch once', () => {
    const sensitive = offeredSensitiveDataSwitches(['products'])
    const own = new Set(['dashboard.home.view'])
    const keys = new Set([
      'data.cost.view',
      'data.supplier_price.view',
      'data.profit_margin.view',
      'products.items.view',
    ])
    // Costs added, products added, the dashboard removed.
    expect(changeCount(keys, own, sensitive)).toBe(3)
    expect(changeCount(own, own, sensitive)).toBe(0)
  })
})

describe('the switches that differ from the role, named at the top (D-200)', () => {
  it('lists them in the page order: the costs switch first, then the groups', () => {
    const sensitive = offeredSensitiveDataSwitches(['products'])
    const role = new Set(['dashboard.home.view', 'products.items.view'])
    const keys = new Set([
      'products.items.view',
      'products.items.manage',
      'data.cost.view',
      'data.supplier_price.view',
      'data.profit_margin.view',
    ])
    const groups = [
      { keys: ['dashboard.home.view'] as const },
      { keys: ['products.items.view', 'products.items.manage'] as const },
    ]
    expect(
      changedSwitches(keys, role, sensitive, groups).map(({ switchKey, change }) => [
        switchKey,
        change,
      ]),
    ).toEqual([
      ['sensitive:costs', 'added'],
      ['dashboard.home.view', 'removed'],
      ['products.items.manage', 'added'],
    ])
    expect(changedSwitches(role, role, sensitive, groups)).toEqual([])
  })
})
