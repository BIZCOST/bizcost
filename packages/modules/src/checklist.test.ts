import { CHECKLIST_ITEM_IDS, COST_STEP_IDS } from '@bizcost/contracts'
import { can, OWNER_TEMPLATE_KEY, resolveEffective, visibleCategories } from '@bizcost/domain'
import { hasMessage, LOCALES } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS } from './capabilities'
import {
  CHECKLIST_RULES,
  checklistItem,
  checklistItemIds,
  checklistItems,
  COST_STEP_RULES,
  costStepIds,
  costSteps,
  hasArabicName,
  type ChecklistFacts,
  type CostFacts,
} from './checklist'
import type { ModuleId } from './manifests'
import { PERMISSION_CATALOG, type PermissionKey } from './permissions'
import { ROLE_TEMPLATE_KEYS, roleTemplateByKey } from './role-templates'

// The Dashboard's getting-started checklist (docs/PRODUCT.md §10, D-090).

const ALL_ON = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, true]))
const ALL_OFF = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]))

function canFor(templateKey: string) {
  const effective = resolveEffective({
    roleTemplateKey: templateKey,
    rolePermissionKeys: roleTemplateByKey(templateKey)?.permissionKeys ?? [],
    overrides: [],
    catalog: PERMISSION_CATALOG,
  })
  return (key: PermissionKey) => can(effective, key)
}

describe('checklistItemIds', () => {
  it('lists every step, in order, for the owner of a business that uses everything', () => {
    expect(checklistItemIds(ALL_ON, canFor(OWNER_TEMPLATE_KEY))).toEqual([...CHECKLIST_ITEM_IDS])
    expect(CHECKLIST_RULES.map((rule) => rule.id)).toEqual([...CHECKLIST_ITEM_IDS])
  })

  it('shows only the profile to the owner of a solo, single-branch business without VAT', () => {
    expect(checklistItemIds(ALL_OFF, canFor(OWNER_TEMPLATE_KEY))).toEqual(['profile'])
  })

  it('shows each step only with its capability', () => {
    const owner = canFor(OWNER_TEMPLATE_KEY)
    expect(checklistItemIds({ ...ALL_OFF, vat_registered: true }, owner)).toEqual([
      'profile',
      'trn',
    ])
    expect(checklistItemIds({ ...ALL_OFF, has_team: true }, owner)).toEqual(['profile', 'invite'])
    expect(checklistItemIds({ ...ALL_OFF, multi_location: true }, owner)).toEqual([
      'profile',
      'location',
    ])
    // Capabilities that no step needs change nothing.
    const others = { ...ALL_OFF, keeps_stock: true, uses_machines: true, sells_via_pos: true }
    expect(checklistItemIds(others, owner)).toEqual(['profile'])
  })

  it('shows only the steps each role template can act on', () => {
    const byTemplate = Object.fromEntries(
      ROLE_TEMPLATE_KEYS.map((key) => [key, checklistItemIds(ALL_ON, canFor(key))]),
    )
    expect(byTemplate).toEqual({
      owner: ['profile', 'trn', 'invite', 'location'],
      admin: ['profile', 'trn', 'invite', 'location'],
      // Sees the business and the team, manages branches.
      manager: ['location'],
      accountant: [],
      sales: [],
      supervisor: [],
      employee: [],
    })
  })

  it('follows a role that was edited', () => {
    const only = (keys: string[]) => (key: PermissionKey) => keys.includes(key)
    expect(checklistItemIds(ALL_ON, only(['settings.members.manage']))).toEqual(['invite'])
    expect(checklistItemIds(ALL_ON, only(['settings.business.edit']))).toEqual(['profile', 'trn'])
  })
})

const BLANK: ChecklistFacts = {
  legalName: 'Maha Bakes',
  legalNameAr: null,
  hasLogo: false,
  trn: null,
  activeMembers: 1,
  pendingInvitations: 0,
  locations: 1,
  teamBeforeMember: false,
  secondBranchBeforeMember: false,
}

describe('checklistItem', () => {
  it('needs the name in Arabic and a logo for a complete profile', () => {
    expect(checklistItem('profile', BLANK)).toEqual({
      id: 'profile',
      done: false,
      missing: ['arabicName', 'logo'],
    })
    expect(checklistItem('profile', { ...BLANK, legalNameAr: 'مها للحلويات' })).toEqual({
      id: 'profile',
      done: false,
      missing: ['logo'],
    })
    expect(checklistItem('profile', { ...BLANK, hasLogo: true })).toMatchObject({
      missing: ['arabicName'],
    })
    const complete = { ...BLANK, legalNameAr: 'مها للحلويات', hasLogo: true }
    expect(checklistItem('profile', complete)).toEqual({ id: 'profile', done: true, missing: [] })
  })

  it('takes a name written in Arabic as the Arabic name', () => {
    expect(hasArabicName({ legalName: 'حلويات سارة', legalNameAr: null })).toBe(true)
    expect(hasArabicName({ legalName: 'BizCost مخبز', legalNameAr: null })).toBe(true)
    expect(hasArabicName({ legalName: 'Sara 123', legalNameAr: '   ' })).toBe(false)
    // Arabic-Indic digits alone are not a name in Arabic.
    expect(hasArabicName({ legalName: 'Shop ١٢', legalNameAr: null })).toBe(false)
  })

  it('is done once the TRN is saved', () => {
    expect(checklistItem('trn', BLANK).done).toBe(false)
    expect(checklistItem('trn', { ...BLANK, trn: '100123456700003' }).done).toBe(true)
  })

  it('counts the team as started with another member or an invitation waiting', () => {
    expect(checklistItem('invite', BLANK).done).toBe(false)
    expect(checklistItem('invite', { ...BLANK, activeMembers: 2 }).done).toBe(true)
    expect(checklistItem('invite', { ...BLANK, pendingInvitations: 1 }).done).toBe(true)
  })

  it('is done with a second branch', () => {
    expect(checklistItem('location', BLANK).done).toBe(false)
    expect(checklistItem('location', { ...BLANK, locations: 2 }).done).toBe(true)
  })
})

describe('checklistItems', () => {
  const ALL = [...CHECKLIST_ITEM_IDS]
  const ids = (facts: ChecklistFacts) => checklistItems(ALL, facts).map((item) => item.id)

  it('keeps every step, done or not, for the member who was there when it was done', () => {
    const done = { ...BLANK, trn: '100123456700003', activeMembers: 2, locations: 2 }
    expect(checklistItems(ALL, done).map((item) => [item.id, item.done])).toEqual([
      ['profile', false],
      ['trn', true],
      ['invite', true],
      ['location', true],
    ])
  })

  it('leaves out the first team member and the second branch reached before the member joined', () => {
    // An admin invited into the team; a manager who joined a business with two branches.
    const joined = { ...BLANK, activeMembers: 2, teamBeforeMember: true }
    expect(ids(joined)).toEqual(['profile', 'trn', 'location'])
    const branches = { ...BLANK, locations: 3, secondBranchBeforeMember: true }
    expect(ids(branches)).toEqual(['profile', 'trn', 'invite'])
  })

  it('shows the step again, open, once the milestone is lost', () => {
    // The others left; a branch was removed.
    const alone = { ...BLANK, activeMembers: 1, teamBeforeMember: true }
    expect(checklistItems(['invite'], alone)).toEqual([{ id: 'invite', done: false, missing: [] }])
    const one = { ...BLANK, locations: 1, secondBranchBeforeMember: false }
    expect(checklistItems(['location'], one)).toEqual([
      { id: 'location', done: false, missing: [] },
    ])
  })
})

describe('checklist wording', () => {
  it('has every message in both languages', () => {
    const keys = [
      'dashboard.checklist.title',
      'dashboard.checklist.progress',
      'dashboard.allSet.title',
      'dashboard.checklist.items.profile.missingBoth',
      'dashboard.checklist.items.profile.missingArabicName',
      'dashboard.checklist.items.profile.missingLogo',
      ...CHECKLIST_ITEM_IDS.flatMap((id) => [
        `dashboard.checklist.items.${id}.title`,
        `dashboard.checklist.items.${id}.done`,
        `dashboard.checklist.items.${id}.action`,
      ]),
      ...CHECKLIST_ITEM_IDS.filter((id) => id !== 'profile').map(
        (id) => `dashboard.checklist.items.${id}.todo`,
      ),
    ]
    for (const locale of LOCALES) {
      for (const key of keys) expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
    }
  })
})

// "Let's find the real cost of what you sell" (PRODUCT.md §10, M2 Step 7).

describe('cost steps', () => {
  const everyModule = () => true
  const visibleFor = (templateKey: string) => {
    const effective = resolveEffective({
      roleTemplateKey: templateKey,
      rolePermissionKeys: roleTemplateByKey(templateKey)?.permissionKeys ?? [],
      overrides: [],
      catalog: PERMISSION_CATALOG,
    })
    return visibleCategories(effective)
  }
  const idsFor = (
    templateKey: string,
    capabilities: Readonly<Record<string, boolean>> = ALL_OFF,
    active: (id: ModuleId) => boolean = everyModule,
  ) =>
    costStepIds({
      active,
      can: canFor(templateKey),
      visible: visibleFor(templateKey),
      capabilities,
    })

  const EMPTY: CostFacts = {
    items: 0,
    madeProducts: 0,
    madeWithoutRecipe: 0,
    usedMaterials: 0,
    unpricedMaterials: 0,
    runningCostsEntered: false,
    hourlyRateSet: false,
    itemsWithMinutes: 0,
    incompleteCosts: 0,
  }

  it('lists every step, in order, for the owner of a business without a team; the time step goes with a team', () => {
    expect(idsFor(OWNER_TEMPLATE_KEY)).toEqual([...COST_STEP_IDS])
    expect(COST_STEP_RULES.map((rule) => rule.id)).toEqual([...COST_STEP_IDS])
    expect(idsFor(OWNER_TEMPLATE_KEY, ALL_ON)).toEqual([
      'products',
      'recipes',
      'purchases',
      'running_costs',
      'product_costs',
    ])
  })

  it('shows each template only what it can do and see', () => {
    expect(idsFor('admin', ALL_ON)).toEqual(idsFor(OWNER_TEMPLATE_KEY, ALL_ON))
    expect(idsFor('manager', ALL_ON)).toEqual(idsFor(OWNER_TEMPLATE_KEY, ALL_ON))
    // The accountant sees product costs but changes nothing.
    expect(idsFor('accountant', ALL_ON)).toEqual(['product_costs'])
    for (const key of ['sales', 'supervisor', 'employee'])
      expect(idsFor(key, ALL_ON), key).toEqual([])
  })

  it('needs the modules of each step on (released and enabled)', () => {
    const without =
      (...off: ModuleId[]) =>
      (id: ModuleId) =>
        !off.includes(id)
    expect(idsFor(OWNER_TEMPLATE_KEY, ALL_OFF, without('cost_engine'))).toEqual([
      'products',
      'recipes',
      'purchases',
      'running_costs',
    ])
    // A services business without Materials and Purchases.
    expect(idsFor(OWNER_TEMPLATE_KEY, ALL_OFF, without('materials', 'purchases'))).toEqual([
      'products',
      'running_costs',
      'owner_time',
      'product_costs',
    ])
    expect(idsFor(OWNER_TEMPLATE_KEY, ALL_OFF, without('products'))).toEqual(['running_costs'])
  })

  it('never shows the steps about costs to a member who cannot see them, whatever else they hold', () => {
    const noCosts = costStepIds({
      active: everyModule,
      can: () => true,
      visible: new Set(),
      capabilities: ALL_OFF,
    })
    expect(noCosts).toEqual(['products', 'recipes', 'purchases', 'running_costs'])
  })

  it('says what is done from the data, and what is left', () => {
    const ids = [...COST_STEP_IDS]
    // Nothing yet: every step open.
    expect(costSteps(ids, EMPTY)).toEqual([
      { id: 'products', done: false, missing: [], remaining: null },
      { id: 'recipes', done: false, missing: [], remaining: null },
      { id: 'purchases', done: false, missing: [], remaining: null },
      { id: 'running_costs', done: false, missing: ['runningCosts'], remaining: null },
      { id: 'owner_time', done: false, missing: ['hourlyRate', 'minutes'], remaining: null },
      { id: 'product_costs', done: false, missing: [], remaining: null },
    ])
    // A café: 3 drinks made here, one without its recipe; 5 materials, 2 never bought; running
    // costs entered: that step is done (no estimate of purchases is ever asked, D-202).
    const cafe: CostFacts = {
      ...EMPTY,
      items: 3,
      madeProducts: 3,
      madeWithoutRecipe: 1,
      usedMaterials: 5,
      unpricedMaterials: 2,
      runningCostsEntered: true,
      hourlyRateSet: true,
      itemsWithMinutes: 1,
      incompleteCosts: 3,
    }
    expect(costSteps(ids, cafe)).toEqual([
      { id: 'products', done: true, missing: [], remaining: null },
      { id: 'recipes', done: false, missing: [], remaining: 1 },
      { id: 'purchases', done: false, missing: [], remaining: 2 },
      { id: 'running_costs', done: true, missing: [], remaining: null },
      { id: 'owner_time', done: true, missing: [], remaining: null },
      { id: 'product_costs', done: false, missing: [], remaining: 3 },
    ])
    // Everything in: every step done.
    const done: CostFacts = {
      ...cafe,
      madeWithoutRecipe: 0,
      unpricedMaterials: 0,
      incompleteCosts: 0,
    }
    expect(costSteps(ids, done).every((step) => step.done)).toBe(true)
  })

  it('asks no recipe of items bought ready to sell or services, and no prices of services without materials', () => {
    const ids = [...COST_STEP_IDS]
    const shop: CostFacts = { ...EMPTY, items: 4, usedMaterials: 4, unpricedMaterials: 1 }
    expect(costSteps(ids, shop).map((s) => s.id)).toEqual([
      'products',
      'purchases',
      'running_costs',
      'owner_time',
      'product_costs',
    ])
    const services: CostFacts = { ...EMPTY, items: 2 }
    expect(costSteps(ids, services).map((s) => s.id)).toEqual([
      'products',
      'running_costs',
      'owner_time',
      'product_costs',
    ])
    // Services that use materials: their prices are asked.
    expect(costSteps(ids, { ...services, usedMaterials: 1 }).map((s) => s.id)).toContain(
      'purchases',
    )
  })

  it('asks running costs of a business that sells only services too: they reach every item by its price (D-202)', () => {
    const ids = [...COST_STEP_IDS]
    // The freelance designer: services only, none with materials.
    expect(costSteps(ids, EMPTY).map((s) => s.id)).toContain('running_costs')
    const designer: CostFacts = { ...EMPTY, items: 4 }
    expect(costSteps(ids, designer)).toEqual([
      { id: 'products', done: true, missing: [], remaining: null },
      { id: 'running_costs', done: false, missing: ['runningCosts'], remaining: null },
      { id: 'owner_time', done: false, missing: ['hourlyRate', 'minutes'], remaining: null },
      { id: 'product_costs', done: true, missing: [], remaining: 0 },
    ])
    expect(costSteps(['running_costs'], { ...designer, runningCostsEntered: true })).toEqual([
      { id: 'running_costs', done: true, missing: [], remaining: null },
    ])
  })
})
