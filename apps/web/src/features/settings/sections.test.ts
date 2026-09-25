import { describe, expect, it } from 'vitest'
import { isSectionVisible, sectionOfPath, visibleSections } from './sections'

// Which settings sections a member is offered (the API enforces the same rules).

const TEAM_AND_BRANCHES = { has_team: true, multi_location: true, vat_registered: true }
const SOLO = { has_team: false, multi_location: false, vat_registered: false }

function access(keys: string[] | 'all', capabilities: Record<string, boolean> = TEAM_AND_BRANCHES) {
  return {
    permissions: keys === 'all' ? { all: true, keys: [] } : { all: false, keys },
    capabilities,
  }
}

describe('settings sections', () => {
  it('shows the owner every section of a business with a team and branches', () => {
    expect(visibleSections(access('all'))).toEqual([
      'business',
      'locations',
      'members',
      'roles',
      'modules',
      'language',
    ])
  })

  it('hides team, roles and branches from a solo, single-location business', () => {
    expect(visibleSections(access('all', SOLO))).toEqual(['business', 'modules', 'language'])
  })

  it('follows the role templates', () => {
    const manager = [
      'dashboard.home.view',
      'settings.business.view',
      'settings.members.view',
      'settings.locations.manage',
    ]
    expect(visibleSections(access(manager))).toEqual([
      'business',
      'locations',
      'members',
      'language',
    ])
    expect(visibleSections(access(['dashboard.home.view', 'settings.members.view']))).toEqual([
      'members',
    ])
    expect(visibleSections(access(['dashboard.home.view']))).toEqual([])
  })

  it('needs the capability and the permission together', () => {
    expect(isSectionVisible(access(['settings.roles.manage'], SOLO), 'roles')).toBe(false)
    expect(isSectionVisible(access(['settings.roles.manage']), 'roles')).toBe(true)
    expect(isSectionVisible(access([]), 'locations')).toBe(false)
  })

  it('reads the section from a settings path', () => {
    const id = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
    expect(sectionOfPath(`/b/${id}/settings`)).toBeNull()
    expect(sectionOfPath(`/b/${id}/settings/members`)).toBe('members')
    expect(sectionOfPath(`/b/${id}/settings/unknown`)).toBeNull()
  })
})
