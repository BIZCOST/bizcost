import type { BusinessContextDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import type { PermissionKey } from '@bizcost/modules'

// The sections of Settings (ROADMAP.md Step 6) and who sees them. Capabilities hide what a business
// doesn't use (docs/PRODUCT.md §5: a solo business has no team or role screens, a single-location
// business no branch screens); permissions hide what the member may not open. Both are enforced again
// by the API: this only decides what the page offers.

export const SETTINGS_SECTIONS = [
  'business',
  'locations',
  'channels',
  'members',
  'roles',
  'modules',
  'books',
  'approval',
  'costing',
  'language',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

type Access = Pick<BusinessContextDto, 'permissions' | 'capabilities'> & {
  /** The modules on for the business (business.context); a section of a module needs it on. */
  readonly modules?: readonly { readonly id: string }[]
}

/** Whether the member holds `key` in this business (the owner holds every key). */
export function can(access: Pick<BusinessContextDto, 'permissions'>, key: PermissionKey): boolean {
  return access.permissions.all || access.permissions.keys.includes(key)
}

function capability(access: Access, key: string): boolean {
  return access.capabilities[key] === true
}

function hasModule(access: Access, id: string): boolean {
  return (access.modules ?? []).some((module) => module.id === id)
}

/** Whether the member may open `section` in this business. */
export function isSectionVisible(access: Access, section: SettingsSection): boolean {
  switch (section) {
    case 'business':
    case 'language':
      return can(access, 'settings.business.view')
    case 'locations':
      return capability(access, 'multi_location') && can(access, 'settings.locations.manage')
    case 'channels':
      // Sales channels (M3 Step 2; D-226): Sales on (served: released, or previewed on a local
      // server), and the key to change them (Owner, Admin, Manager).
      return hasModule(access, 'sales') && can(access, 'sales.channels.manage')
    case 'members':
      return capability(access, 'has_team') && can(access, 'settings.members.view')
    case 'roles':
      return capability(access, 'has_team') && can(access, 'settings.roles.manage')
    case 'modules':
      return can(access, 'settings.modules.manage')
    case 'books':
      // "Books closed up to": purchases, expenses and sales obey it, so any of them on shows it
      // (D-137, D-176, D-227), with the Settings key to close them (D-201).
      return (
        (hasModule(access, 'purchases') ||
          hasModule(access, 'expenses') ||
          hasModule(access, 'sales')) &&
        can(access, 'settings.books.close')
      )
    case 'approval':
      // Whether expenses need approval: Expenses on, a team (without one nothing is approved, D-164),
      // and the key to choose it (Owner, Admin).
      return (
        capability(access, 'has_team') &&
        (access.modules ?? []).some((module) => module.id === 'expenses') &&
        can(access, 'expenses.approval.manage')
      )
    case 'costing':
      // How product costs are worked out (M2 Step 6; D-119, D-202): the Cost Engine on, and the keys
      // to see product costs and change how they are worked out (Owner, Admin, Manager), as the API
      // checks them (running costs need no setting, so their keys and purchases' are not needed).
      return (
        (access.modules ?? []).some((module) => module.id === 'cost_engine') &&
        can(access, 'cost_engine.product_costs.view') &&
        can(access, 'cost_engine.settings.manage')
      )
  }
}

/** The sections the member may open, in menu order. */
export function visibleSections(access: Access): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => isSectionVisible(access, section))
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(value)
}

/** The section a settings path is in (`/b/<id>/settings/<section>`), null on the settings home. */
export function sectionOfPath(pathname: string): SettingsSection | null {
  const segment = /\/settings\/([^/?#]+)/.exec(pathname)?.[1]
  return isSettingsSection(segment) ? segment : null
}

export function sectionPath(businessId: string, section?: SettingsSection): string {
  return section ? `/b/${businessId}/settings/${section}` : `/b/${businessId}/settings`
}

export const SECTION_TITLES: Readonly<Record<SettingsSection, I18nKey>> = {
  business: 'settings.business.title',
  locations: 'settings.locations.title',
  channels: 'settings.channels.title',
  members: 'settings.members.title',
  roles: 'settings.roles.title',
  modules: 'settings.modules.title',
  books: 'settings.books.title',
  approval: 'settings.approval.title',
  costing: 'settings.costing.title',
  language: 'settings.language.title',
}

/**
 * What a section is about, as its card and its page say it: "Closing the books" names sales too while
 * Sales is on and served (D-236; released businesses keep their words until Release A).
 */
export function sectionDescription(access: Access, section: SettingsSection): I18nKey {
  if (section === 'books' && hasModule(access, 'sales')) return 'settings.books.descriptionSales'
  return SECTION_DESCRIPTIONS[section]
}

export const SECTION_DESCRIPTIONS: Readonly<Record<SettingsSection, I18nKey>> = {
  business: 'settings.business.description',
  locations: 'settings.locations.description',
  channels: 'settings.channels.description',
  members: 'settings.members.description',
  roles: 'settings.roles.description',
  modules: 'settings.modules.description',
  books: 'settings.books.description',
  approval: 'settings.approval.description',
  costing: 'settings.costing.description',
  language: 'settings.language.description',
}
