import { CHECKLIST_ITEM_IDS } from '@bizcost/contracts'
import { can, OWNER_TEMPLATE_KEY, resolveEffective } from '@bizcost/domain'
import { hasMessage, LOCALES } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS } from './capabilities'
import {
  CHECKLIST_RULES,
  checklistItem,
  checklistItemIds,
  checklistItems,
  hasArabicName,
  type ChecklistFacts,
} from './checklist'
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
