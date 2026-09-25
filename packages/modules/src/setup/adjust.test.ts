import { describe, expect, it } from 'vitest'
import type { ModuleId } from '../manifests'
import type { SetupAnswers } from './answers'
import {
  adjustmentsFor,
  applyAdjustments,
  NO_ADJUSTMENTS,
  recommendedState,
  setupModuleRows,
  toggleSetupItem,
  type SetupAdjustments,
  type SetupItem,
  type SetupState,
} from './adjust'
import { recommend } from './recommend'

const COFFEE_SHOP: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}
const DESIGNER: SetupAnswers = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

const coffee = recommend(COFFEE_SHOP)
const designer = recommend(DESIGNER)
const mod = (id: ModuleId): SetupItem => ({ kind: 'module', id })
const cap = (key: Extract<SetupItem, { kind: 'capability' }>['key']): SetupItem => ({
  kind: 'capability',
  key,
})

function applied(rec = coffee, adj: SetupAdjustments): SetupState {
  const result = applyAdjustments(rec, adj)
  if (!result.ok) throw new Error(`${result.issue} ${result.item}`)
  return result.state
}
const ids = (state: SetupState) => [...state.modules]

describe('applyAdjustments', () => {
  it('without adjustments gives the recommendation', () => {
    expect(applied(coffee, NO_ADJUSTMENTS)).toEqual(recommendedState(coffee))
  })

  it('turns a module on with its deps, and the stored capabilities they need', () => {
    const state = applied(designer, {
      modules: [{ id: 'attendance', enabled: true }],
      capabilities: [],
    })
    expect(ids(state)).toEqual(expect.arrayContaining(['attendance', 'employees']))
    expect(state.capabilities.has_team).toBe(true)
    const stock = applied(designer, {
      modules: [{ id: 'usage_waste', enabled: true }],
      capabilities: [],
    })
    expect(ids(stock)).toEqual(
      expect.arrayContaining(['usage_waste', 'inventory', 'materials', 'purchases']),
    )
    expect(stock.capabilities.keeps_stock).toBe(true)
  })

  it('turns a module off with the modules that depend on it', () => {
    const state = applied(coffee, {
      modules: [{ id: 'purchases', enabled: false }],
      capabilities: [],
    })
    for (const id of ['purchases', 'materials', 'inventory', 'usage_waste'] as const) {
      expect(state.modules.has(id), id).toBe(false)
    }
    expect(state.capabilities.keeps_stock).toBe(true)
  })

  it('turns a capability on with its anchor modules, and off with every module needing it', () => {
    const team = applied(designer, {
      modules: [],
      capabilities: [{ key: 'has_team', enabled: true }],
    })
    expect(ids(team)).toContain('employees')
    expect(ids(team)).not.toContain('attendance')
    const noTeam = applied(coffee, {
      modules: [],
      capabilities: [{ key: 'has_team', enabled: false }],
    })
    for (const id of ['employees', 'attendance', 'payroll', 'petty_cash'] as const) {
      expect(noTeam.modules.has(id), id).toBe(false)
    }
    const stock = applied(designer, {
      modules: [],
      capabilities: [{ key: 'keeps_stock', enabled: true }],
    })
    expect(ids(stock)).toEqual(
      expect.arrayContaining(['inventory', 'usage_waste', 'materials', 'purchases']),
    )
  })

  it('turns VAT on with VAT Center, and Invoices when Orders is on', () => {
    const baker = recommend({
      what_you_do: ['food_drinks'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      sales_channels: ['messages'],
      vat: 'no',
    })
    const state = applied(baker, {
      modules: [],
      capabilities: [{ key: 'vat_registered', enabled: true }],
    })
    expect(state.vatRegistered).toBe(true)
    expect(ids(state)).toEqual(expect.arrayContaining(['vat_center', 'invoices']))
  })

  it('applies capabilities before modules', () => {
    const state = applied(coffee, {
      modules: [{ id: 'employees', enabled: true }],
      capabilities: [{ key: 'has_team', enabled: false }],
    })
    expect(state.capabilities.has_team).toBe(true)
    expect(ids(state)).toContain('employees')
    expect(ids(state)).not.toContain('attendance')
  })

  it('never changes VAT as a side effect: a module that needs it is refused', () => {
    expect(
      applyAdjustments(designer, {
        modules: [{ id: 'vat_center', enabled: true }],
        capabilities: [],
      }),
    ).toEqual({ ok: false, issue: 'needs_vat', item: 'vat_center' })
    const off = applied(coffee, {
      modules: [{ id: 'invoices', enabled: true }],
      capabilities: [{ key: 'vat_registered', enabled: false }],
    })
    expect(off.vatRegistered).toBe(false)
    expect(ids(off)).not.toContain('vat_center')
    expect(ids(off)).toContain('invoices')
  })

  it('refuses unknown ids, Dashboard and Settings, and duplicates', () => {
    const refuse = (adj: SetupAdjustments) => {
      const result = applyAdjustments(coffee, adj)
      return result.ok ? null : [result.issue, result.item]
    }
    expect(refuse({ modules: [{ id: 'nope', enabled: true }], capabilities: [] })).toEqual([
      'unknown_module',
      'nope',
    ])
    expect(refuse({ modules: [{ id: 'dashboard', enabled: false }], capabilities: [] })).toEqual([
      'always_on_module',
      'dashboard',
    ])
    expect(refuse({ modules: [{ id: 'settings', enabled: true }], capabilities: [] })).toEqual([
      'always_on_module',
      'settings',
    ])
    expect(refuse({ modules: [], capabilities: [{ key: 'works_alone', enabled: true }] })).toEqual([
      'unknown_capability',
      'works_alone',
    ])
    expect(
      refuse({
        modules: [
          { id: 'orders', enabled: true },
          { id: 'orders', enabled: false },
        ],
        capabilities: [],
      }),
    ).toEqual(['duplicate', 'orders'])
    expect(
      refuse({
        modules: [],
        capabilities: [
          { key: 'has_team', enabled: true },
          { key: 'has_team', enabled: true },
        ],
      }),
    ).toEqual(['duplicate', 'has_team'])
  })
})

describe('toggleSetupItem (the live review)', () => {
  it('reports side effects and returns adjustments that reproduce the state', () => {
    const result = toggleSetupItem(coffee, NO_ADJUSTMENTS, cap('has_team'), false)
    if (!result.ok) throw new Error(result.issue)
    expect(result.turnedOff).toEqual([
      mod('employees'),
      mod('attendance'),
      mod('payroll'),
      mod('petty_cash'),
    ])
    expect(result.turnedOn).toEqual([])
    expect(applied(coffee, result.adjustments)).toEqual(result.state)
  })

  it('gives the recommended sections back when a capability is switched off and on again', () => {
    const off = toggleSetupItem(coffee, NO_ADJUSTMENTS, cap('has_team'), false)
    if (!off.ok) throw new Error(off.issue)
    const on = toggleSetupItem(coffee, off.adjustments, cap('has_team'), true)
    if (!on.ok) throw new Error(on.issue)
    expect(on.turnedOn).toEqual([
      mod('employees'),
      mod('attendance'),
      mod('payroll'),
      mod('petty_cash'),
    ])
    expect(on.state).toEqual(recommendedState(coffee))
    expect(on.adjustments).toEqual(NO_ADJUSTMENTS)
    // Turned on for a business the recommendation had without a team: only the anchor.
    const team = toggleSetupItem(designer, NO_ADJUSTMENTS, cap('has_team'), true)
    if (!team.ok) throw new Error(team.issue)
    expect(team.turnedOn).toEqual([mod('employees')])
  })

  it('keeps a switch the user turned off even when a later capability would turn it on', () => {
    const stock = toggleSetupItem(designer, NO_ADJUSTMENTS, cap('keeps_stock'), true)
    if (!stock.ok) throw new Error(stock.issue)
    expect(stock.turnedOn).toEqual([
      mod('materials'),
      mod('purchases'),
      mod('inventory'),
      mod('usage_waste'),
    ])
    const noWaste = toggleSetupItem(designer, stock.adjustments, mod('usage_waste'), false)
    if (!noWaste.ok) throw new Error(noWaste.issue)
    expect(noWaste.state.modules.has('usage_waste')).toBe(false)
    expect(noWaste.state.modules.has('inventory')).toBe(true)
    expect(applied(designer, noWaste.adjustments)).toEqual(noWaste.state)
    expect(noWaste.adjustments.modules).toContainEqual({ id: 'usage_waste', enabled: false })
  })

  it('lets a capability turned off stay off after a module needed it', () => {
    const on = toggleSetupItem(designer, NO_ADJUSTMENTS, mod('attendance'), true)
    if (!on.ok) throw new Error(on.issue)
    expect(on.turnedOn).toEqual([mod('employees'), cap('has_team')])
    const off = toggleSetupItem(designer, on.adjustments, cap('has_team'), false)
    if (!off.ok) throw new Error(off.issue)
    expect(off.state).toEqual(recommendedState(designer))
    expect(off.adjustments).toEqual(NO_ADJUSTMENTS)
  })

  it('refuses a module that needs VAT while VAT is off', () => {
    expect(toggleSetupItem(designer, NO_ADJUSTMENTS, mod('vat_center'), true)).toEqual({
      ok: false,
      issue: 'needs_vat',
      item: 'vat_center',
    })
    expect(toggleSetupItem(designer, NO_ADJUSTMENTS, mod('dashboard'), false)).toMatchObject({
      ok: false,
      issue: 'always_on_module',
    })
  })

  it('adjustmentsFor gives nothing for the recommendation itself', () => {
    expect(adjustmentsFor(coffee, recommendedState(coffee))).toEqual(NO_ADJUSTMENTS)
  })
})

describe('setupModuleRows (D-059)', () => {
  it('writes enabled rows for optional modules on and disabled rows for core modules off', () => {
    expect(setupModuleRows(recommendedState(coffee))).toEqual([
      { moduleKey: 'customers', enabled: false },
      { moduleKey: 'payments', enabled: false },
      { moduleKey: 'inventory', enabled: true },
      { moduleKey: 'usage_waste', enabled: true },
      { moduleKey: 'employees', enabled: true },
      { moduleKey: 'attendance', enabled: true },
      { moduleKey: 'payroll', enabled: true },
      { moduleKey: 'petty_cash', enabled: true },
      { moduleKey: 'vat_center', enabled: true },
    ])
    expect(setupModuleRows(recommendedState(designer))).toEqual([
      { moduleKey: 'materials', enabled: false },
      { moduleKey: 'purchases', enabled: false },
      { moduleKey: 'quotations', enabled: true },
      { moduleKey: 'invoices', enabled: true },
    ])
  })
})
