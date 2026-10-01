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

  it('offers closing the books with Purchases or Expenses on and the key to close them (D-137, D-176)', () => {
    const purchases = { modules: [{ id: 'purchases' }] }
    expect(isSectionVisible({ ...access('all'), ...purchases }, 'books')).toBe(true)
    // Expenses obey the date too: a business without Purchases can still open its books.
    expect(isSectionVisible({ ...access('all'), modules: [{ id: 'expenses' }] }, 'books')).toBe(
      true,
    )
    expect(isSectionVisible(access('all'), 'books')).toBe(false)
    expect(
      isSectionVisible({ ...access(['purchases.documents.view']), ...purchases }, 'books'),
    ).toBe(false)
    expect(
      isSectionVisible({ ...access(['settings.books.close'], SOLO), ...purchases }, 'books'),
    ).toBe(true)
    expect(visibleSections({ ...access('all', SOLO), ...purchases })).toEqual([
      'business',
      'modules',
      'books',
      'language',
    ])
  })

  it('offers expense approval only with Expenses on, a team and the key to choose it (D-164)', () => {
    const expenses = { modules: [{ id: 'expenses' }] }
    expect(isSectionVisible({ ...access('all'), ...expenses }, 'approval')).toBe(true)
    // Without Expenses, or without a team (nothing is approved in a solo business).
    expect(isSectionVisible(access('all'), 'approval')).toBe(false)
    expect(isSectionVisible({ ...access('all', SOLO), ...expenses }, 'approval')).toBe(false)
    // A Manager approves expenses but does not choose whether they need approval.
    expect(
      isSectionVisible(
        { ...access(['expenses.documents.view', 'expenses.documents.approve']), ...expenses },
        'approval',
      ),
    ).toBe(false)
    expect(
      isSectionVisible({ ...access(['expenses.approval.manage']), ...expenses }, 'approval'),
    ).toBe(true)
    expect(visibleSections({ ...access('all'), ...expenses })).toEqual([
      'business',
      'locations',
      'members',
      'roles',
      'modules',
      // Expenses obey the books-closed date too (D-176).
      'books',
      'approval',
      'language',
    ])
  })

  it('offers how costs are worked out with the Cost Engine on and its keys (M2 Step 6)', () => {
    const costEngine = { modules: [{ id: 'products' }, { id: 'cost_engine' }] }
    expect(isSectionVisible({ ...access('all'), ...costEngine }, 'costing')).toBe(true)
    // A solo business too: its owner's hourly rate is set here (D-119).
    expect(isSectionVisible({ ...access('all', SOLO), ...costEngine }, 'costing')).toBe(true)
    expect(isSectionVisible(access('all'), 'costing')).toBe(false)
    // Seeing product costs is not changing how they are worked out (an Accountant).
    expect(
      isSectionVisible(
        { ...access(['cost_engine.product_costs.view', 'products.recipes.view']), ...costEngine },
        'costing',
      ),
    ).toBe(false)
    // Its keys alone, as the API checks them: running costs need no setting any more, so neither
    // their keys nor purchases' are needed (D-202).
    const manage = ['cost_engine.product_costs.view', 'cost_engine.settings.manage'] as const
    expect(isSectionVisible({ ...access([...manage]), ...costEngine }, 'costing')).toBe(true)
    expect(
      isSectionVisible({ ...access(['cost_engine.product_costs.view']), ...costEngine }, 'costing'),
    ).toBe(false)
    expect(visibleSections({ ...access('all', SOLO), ...costEngine })).toEqual([
      'business',
      'modules',
      'costing',
      'language',
    ])
    const id = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
    expect(sectionOfPath(`/b/${id}/settings/costing`)).toBe('costing')
  })

  it('reads the section from a settings path', () => {
    const id = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
    expect(sectionOfPath(`/b/${id}/settings`)).toBeNull()
    expect(sectionOfPath(`/b/${id}/settings/members`)).toBe('members')
    expect(sectionOfPath(`/b/${id}/settings/unknown`)).toBeNull()
  })
})
