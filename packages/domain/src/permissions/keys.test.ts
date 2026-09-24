import { describe, expect, it } from 'vitest'
import { isPermissionKey } from './keys'

describe('isPermissionKey', () => {
  it('accepts module.resource.action in lowercase snake_case', () => {
    for (const key of [
      'dashboard.home.view',
      'settings.members.manage',
      'data.profit_margin.view',
      'running_costs.cost2.edit',
    ]) {
      expect(isPermissionKey(key)).toBe(true)
    }
  })

  it('rejects other shapes', () => {
    for (const key of [
      '',
      'dashboard',
      'dashboard.view',
      'a.b.c.d',
      'Dashboard.home.view',
      'dashboard.home.View',
      'dashboard..view',
      '.home.view',
      'dashboard.home.',
      '1dash.home.view',
      '_dash.home.view',
      'dash-board.home.view',
      'dashboard.home.view ',
      ' dashboard.home.view',
      'dashboard.home.view\n',
    ]) {
      expect(isPermissionKey(key)).toBe(false)
    }
    expect(isPermissionKey(null)).toBe(false)
    expect(isPermissionKey(42)).toBe(false)
  })
})
