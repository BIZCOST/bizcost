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
  'members',
  'roles',
  'modules',
  'books',
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

/** Whether the member may open `section` in this business. */
export function isSectionVisible(access: Access, section: SettingsSection): boolean {
  switch (section) {
    case 'business':
    case 'language':
      return can(access, 'settings.business.view')
    case 'locations':
      return capability(access, 'multi_location') && can(access, 'settings.locations.manage')
    case 'members':
      return capability(access, 'has_team') && can(access, 'settings.members.view')
    case 'roles':
      return capability(access, 'has_team') && can(access, 'settings.roles.manage')
    case 'modules':
      return can(access, 'settings.modules.manage')
    case 'books':
      // "Books closed up to" belongs to Purchases, the first module that posts (D-137).
      return (
        (access.modules ?? []).some((module) => module.id === 'purchases') &&
        can(access, 'purchases.books.close')
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
  members: 'settings.members.title',
  roles: 'settings.roles.title',
  modules: 'settings.modules.title',
  books: 'settings.books.title',
  language: 'settings.language.title',
}

export const SECTION_DESCRIPTIONS: Readonly<Record<SettingsSection, I18nKey>> = {
  business: 'settings.business.description',
  locations: 'settings.locations.description',
  members: 'settings.members.description',
  roles: 'settings.roles.description',
  modules: 'settings.modules.description',
  books: 'settings.books.description',
  language: 'settings.language.description',
}
