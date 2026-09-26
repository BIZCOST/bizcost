import { newId } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { businessContextDto, locationScopeDto } from './business-context'
import { dashboardChecklistDto } from './dashboard'
import { healthDto } from './health'
import { meDto } from './me'

describe('healthDto', () => {
  it('parses the health payload', () => {
    const health = { ok: true, region: 'bom1', version: '0.0.0' }
    expect(healthDto.parse(health)).toEqual(health)
  })
})

describe('meDto', () => {
  const me = {
    profile: { id: newId(), displayName: 'Rashed', locale: 'ar', lastBusinessId: null },
    memberships: [
      { businessId: newId(), legalName: 'Bakery', roleTemplateKey: 'owner', status: 'active' },
      { businessId: newId(), legalName: 'Shop', roleTemplateKey: null, status: 'active' },
    ],
  }

  it('parses a profile with memberships', () => {
    expect(meDto.parse(me)).toEqual(me)
  })

  it('rejects an unknown locale or member status', () => {
    expect(meDto.safeParse({ ...me, profile: { ...me.profile, locale: 'fr' } }).success).toBe(false)
    const membership = { ...me.memberships[0], status: 'deleted' }
    expect(meDto.safeParse({ ...me, memberships: [membership] }).success).toBe(false)
  })
})

describe('locationScopeDto', () => {
  it('is either all locations or a list of ids', () => {
    const id = newId()
    expect(locationScopeDto.parse({ all: true })).toEqual({ all: true })
    expect(locationScopeDto.parse({ all: false, ids: [id] })).toEqual({ all: false, ids: [id] })
    expect(locationScopeDto.safeParse({ all: false }).success).toBe(false)
    expect(locationScopeDto.safeParse({ all: false, ids: ['x'] }).success).toBe(false)
  })
})

describe('businessContextDto', () => {
  const context = {
    roleTemplateKey: 'employee',
    permissions: { all: false, keys: ['dashboard.home.view'] },
    locationScope: { all: true },
    visibleCategories: [],
    modules: [
      {
        id: 'dashboard',
        nav: [
          {
            id: 'dashboard',
            labelKey: 'nav.dashboard',
            path: '',
            icon: 'layout-dashboard',
            group: 'main',
          },
        ],
        quickActions: [],
      },
    ],
    terminologyProfile: 'food',
    capabilities: { has_team: true, vat_registered: false },
    permissionsVersion: 3,
  }

  it('parses a member context', () => {
    expect(businessContextDto.parse(context)).toEqual(context)
  })

  it('strips fields a nav entry does not declare (e.g. its permission key)', () => {
    const entry = {
      id: 's',
      labelKey: 'nav.settings',
      path: 'settings',
      icon: 'settings',
      group: 'system',
    }
    const parsed = businessContextDto.parse({
      ...context,
      modules: [{ id: 'settings', nav: [{ ...entry, permission: 'x.y.z' }], quickActions: [] }],
    })
    expect(parsed.modules[0]?.nav[0]).toEqual(entry)
  })

  it('rejects unknown sensitivity categories and non-integer versions', () => {
    const badCategory = { ...context, visibleCategories: ['price'] }
    expect(businessContextDto.safeParse(badCategory).success).toBe(false)
    const badVersion = { ...context, permissionsVersion: 1.5 }
    expect(businessContextDto.safeParse(badVersion).success).toBe(false)
    const badProfile = { ...context, terminologyProfile: 'retail' }
    expect(businessContextDto.safeParse(badProfile).success).toBe(false)
  })
})

describe('dashboardChecklistDto', () => {
  it('parses the steps with their state', () => {
    const checklist = {
      items: [
        { id: 'profile', done: false, missing: ['logo'] },
        { id: 'trn', done: true, missing: [] },
      ],
    }
    expect(dashboardChecklistDto.parse(checklist)).toEqual(checklist)
  })

  it('rejects unknown steps and profile parts', () => {
    const step = { id: 'products', done: false, missing: [] }
    expect(dashboardChecklistDto.safeParse({ items: [step] }).success).toBe(false)
    const part = { id: 'profile', done: false, missing: ['email'] }
    expect(dashboardChecklistDto.safeParse({ items: [part] }).success).toBe(false)
  })
})
