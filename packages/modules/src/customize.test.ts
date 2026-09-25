import { describe, expect, it } from 'vitest'
import { resolveCapabilities } from './capabilities'
import {
  businessStateOf,
  changedCapabilities,
  changedModules,
  toggleBusinessItem,
} from './customize'
import type { ModuleId } from './manifests'
import { resolveEnabledModules } from './registry'
import { isValidSetupState, recommendedState, type SetupItem } from './setup/adjust'
import type { SetupAnswers } from './setup/answers'
import { recommend } from './setup/recommend'

const WORKSHOP: SetupAnswers = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock', 'machines', 'vehicles'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}
const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

const mod = (id: ModuleId): SetupItem => ({ kind: 'module', id })
const cap = (key: Extract<SetupItem, { kind: 'capability' }>['key']): SetupItem => ({
  kind: 'capability',
  key,
})

const workshop = recommendedState(recommend(WORKSHOP))
const baker = recommendedState(recommend(BAKER))

function ok(result: ReturnType<typeof toggleBusinessItem>) {
  if (!result.ok) throw new Error(`refused: ${result.issue} ${result.item}`)
  return result
}

describe('businessStateOf', () => {
  it('reads the resolved modules and capabilities, with Dashboard and Settings always on', () => {
    const state = businessStateOf({
      enabledModules: resolveEnabledModules([{ key: 'employees', enabled: true }]),
      capabilities: resolveCapabilities({
        stored: [{ key: 'has_team', enabled: true }],
        derived: { vat_registered: true },
      }),
    })
    expect(state.modules.has('dashboard')).toBe(true)
    expect(state.modules.has('settings')).toBe(true)
    expect(state.modules.has('employees')).toBe(true)
    expect(state.modules.has('products')).toBe(true) // core: on without a row
    expect(state.capabilities.has_team).toBe(true)
    expect(state.capabilities.multi_location).toBe(false)
    expect(state.vatRegistered).toBe(true)
    expect(isValidSetupState(state)).toBe(true)
  })

  it('adds Dashboard and Settings even when the list lacks them', () => {
    const state = businessStateOf({
      enabledModules: ['products'],
      capabilities: resolveCapabilities({ stored: [], derived: { vat_registered: false } }),
    })
    expect([...state.modules]).toEqual(['dashboard', 'settings', 'products'])
  })
})

describe('toggleBusinessItem', () => {
  it('turning the team off turns off every module that needs it', () => {
    const result = ok(toggleBusinessItem(workshop, cap('has_team'), false))
    expect(result.state.capabilities.has_team).toBe(false)
    for (const id of ['employees', 'attendance', 'payroll', 'petty_cash'] as const) {
      expect(workshop.modules.has(id)).toBe(true)
      expect(result.state.modules.has(id)).toBe(false)
    }
    expect(result.turnedOff).toEqual([
      mod('employees'),
      mod('attendance'),
      mod('payroll'),
      mod('petty_cash'),
    ])
    expect(result.turnedOn).toEqual([])
    expect(isValidSetupState(result.state)).toBe(true)
  })

  it('turning the team on brings its anchor module only (no recommendation to restore)', () => {
    const result = ok(toggleBusinessItem(baker, cap('has_team'), true))
    expect(result.turnedOn).toEqual([mod('employees')])
    expect(result.state.modules.has('attendance')).toBe(false)
  })

  it('turning a module on turns on its deps and the capabilities they need', () => {
    const noStock = ok(toggleBusinessItem(baker, mod('materials'), false)).state
    const result = ok(toggleBusinessItem(noStock, mod('usage_waste'), true))
    expect(result.state.capabilities.keeps_stock).toBe(true)
    expect(result.turnedOn).toEqual(
      expect.arrayContaining([mod('materials'), mod('inventory'), cap('keeps_stock')]),
    )
  })

  it('turning a module off turns off the modules that depend on it', () => {
    const result = ok(toggleBusinessItem(workshop, mod('customers'), false))
    for (const id of ['orders', 'quotations', 'invoices', 'projects'] as const) {
      expect(result.state.modules.has(id)).toBe(false)
    }
    expect(result.state.modules.has('payments')).toBe(true)
  })

  it('VAT follows the same rules when the business profile switches it', () => {
    const off = ok(toggleBusinessItem(workshop, cap('vat_registered'), false))
    expect(off.state.vatRegistered).toBe(false)
    expect(off.turnedOff).toEqual([mod('vat_center')])
    // The baker takes orders, so tax invoices come with VAT (the review's rule).
    const on = ok(toggleBusinessItem(baker, cap('vat_registered'), true))
    expect(on.turnedOn).toEqual([mod('invoices'), mod('vat_center')])
  })

  it('refuses a module that needs VAT while VAT is off, and the always-on modules', () => {
    expect(toggleBusinessItem(baker, mod('vat_center'), true)).toEqual({
      ok: false,
      issue: 'needs_vat',
      item: 'vat_center',
    })
    expect(toggleBusinessItem(baker, mod('settings'), false)).toMatchObject({
      ok: false,
      issue: 'always_on_module',
    })
    expect(toggleBusinessItem(baker, mod('nope' as ModuleId), true)).toMatchObject({
      ok: false,
      issue: 'unknown_module',
    })
  })

  it('switching something off and on again is safe and leaves a valid state', () => {
    let state = workshop
    for (const item of [cap('keeps_stock'), mod('products'), cap('uses_machines')]) {
      state = ok(toggleBusinessItem(state, item, false)).state
      expect(isValidSetupState(state)).toBe(true)
      state = ok(toggleBusinessItem(state, item, true)).state
      expect(isValidSetupState(state)).toBe(true)
    }
  })
})

describe('changedModules / changedCapabilities', () => {
  it('list what differs between two states', () => {
    const after = ok(toggleBusinessItem(workshop, cap('has_team'), false)).state
    expect(changedModules(workshop, after)).toEqual([
      { id: 'employees', enabled: false },
      { id: 'attendance', enabled: false },
      { id: 'payroll', enabled: false },
      { id: 'petty_cash', enabled: false },
    ])
    expect(changedCapabilities(workshop, after)).toEqual([{ key: 'has_team', enabled: false }])
    expect(changedModules(workshop, workshop)).toEqual([])
  })
})
