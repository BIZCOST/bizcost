import { ROLE_TEMPLATES } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { canGrantKey, canGrantRole, isTemplateDefault, roleNameKey } from './role-labels'

const manager = ROLE_TEMPLATES.find((t) => t.key === 'manager')!

describe('role labels', () => {
  it('name template roles by their template, custom roles by their own name', () => {
    expect(roleNameKey('employee')).toBe('roles.employee')
    expect(roleNameKey(null)).toBeNull()
    expect(roleNameKey('made_up')).toBeNull()
  })

  it('describe a role by its template only while it grants what the template grants', () => {
    const keys = [...manager.permissionKeys]
    expect(isTemplateDefault({ templateKey: 'manager', permissionKeys: keys.reverse() })).toBe(true)
    expect(isTemplateDefault({ templateKey: 'manager', permissionKeys: keys.slice(1) })).toBe(false)
    expect(isTemplateDefault({ templateKey: 'owner', permissionKeys: [] })).toBe(false)
    expect(isTemplateDefault({ templateKey: null, permissionKeys: [] })).toBe(false)
  })
})

describe('what a member may hand out', () => {
  const owner = { permissions: { all: true, keys: [] } }
  const teamManager = {
    permissions: { all: false, keys: ['settings.members.view', 'settings.members.manage'] },
  }

  it('never the Owner role; any other role for the owner', () => {
    expect(canGrantRole(owner, { isOwner: true, permissionKeys: [] })).toBe(false)
    expect(canGrantRole(owner, { isOwner: false, permissionKeys: ['data.cost.view'] })).toBe(true)
    expect(canGrantKey(owner, 'settings.roles.manage')).toBe(true)
  })

  it('only access they hold themselves otherwise', () => {
    const viewer = { isOwner: false, permissionKeys: ['settings.members.view'] }
    expect(canGrantRole(teamManager, viewer)).toBe(true)
    const costs = { isOwner: false, permissionKeys: ['data.cost.view'] }
    expect(canGrantRole(teamManager, costs)).toBe(false)
    expect(canGrantKey(teamManager, 'settings.members.manage')).toBe(true)
    expect(canGrantKey(teamManager, 'settings.roles.manage')).toBe(false)
  })
})
