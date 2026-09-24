import { can, OWNER_TEMPLATE_KEY, resolveEffective } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  DERIVED_CAPABILITY_KEYS,
  isStoredCapabilityKey,
  resolveCapabilities,
  STORED_CAPABILITY_KEYS,
} from './capabilities'
import { MODULES } from './manifests'
import { isCatalogPermissionKey, PERMISSION_CATALOG } from './permissions'
import { isRoleTemplateKey, roleTemplateByKey } from './role-templates'
import {
  buildModuleNav,
  isModuleActive,
  isModuleEnabled,
  isModuleReleased,
  isModuleVisible,
  moduleById,
  releasedModules,
  resolveEnabledModules,
  visibleNav,
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
    expect(releasedModules().map((m) => m.id)).toEqual(['dashboard', 'settings'])
    expect(releasedModules().every(isModuleReleased)).toBe(true)
  })

  it('isCatalogPermissionKey accepts catalog keys only', () => {
    expect(isCatalogPermissionKey('settings.roles.manage')).toBe(true)
    expect(isCatalogPermissionKey('data.cost.view')).toBe(true)
    expect(isCatalogPermissionKey('settings.ownership.transfer')).toBe(false)
    expect(isCatalogPermissionKey(undefined)).toBe(false)
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
        nav: [{ id: 'dashboard', labelKey: 'nav.dashboard', path: '', icon: 'layout-dashboard' }],
        quickActions: [],
      },
      {
        id: 'settings',
        nav: [{ id: 'settings', labelKey: 'nav.settings', path: 'settings', icon: 'settings' }],
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
