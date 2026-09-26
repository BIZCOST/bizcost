import { SENSITIVITY_CATEGORIES, TERMINOLOGY_PROFILES } from '@bizcost/domain'
import { z } from 'zod'
import { zUuid } from '../primitives'

/** Effective permissions. `all` is true only for the owner template; `keys` lists granted keys. */
export const effectivePermissionsDto = z.object({
  all: z.boolean(),
  keys: z.array(z.string()),
})
export type EffectivePermissionsDto = z.infer<typeof effectivePermissionsDto>

/** Locations the member may use: all of them, or only `ids`. */
export const locationScopeDto = z.discriminatedUnion('all', [
  z.object({ all: z.literal(true) }),
  z.object({ all: z.literal(false), ids: z.array(zUuid) }),
])
export type LocationScopeDto = z.infer<typeof locationScopeDto>

/**
 * Where a navigation entry goes: `main` with the business's sections, in manifest order; `system`
 * after them (Settings: the sidebar's foot, the last tab), so new sections come before it.
 */
export const NAV_GROUPS = ['main', 'system'] as const
export type NavGroup = (typeof NAV_GROUPS)[number]

/** A "+" action of a module manifest. `path` and `icon` as for a navigation entry. */
export const quickActionDto = z.object({
  id: z.string(),
  labelKey: z.string(),
  path: z.string(),
  icon: z.string(),
})
export type QuickActionDto = z.infer<typeof quickActionDto>

/**
 * A navigation entry of a module manifest. `path` is relative to the business root
 * ('' = business home; the web app prefixes /b/[businessId]/). `icon` is a lucide icon name.
 */
export const navEntryDto = quickActionDto.extend({ group: z.enum(NAV_GROUPS) })
export type NavEntryDto = z.infer<typeof navEntryDto>

/** A module that is released and enabled for the business, with the entries this member may use. */
export const enabledModuleDto = z.object({
  id: z.string(),
  nav: z.array(navEntryDto),
  quickActions: z.array(quickActionDto),
})
export type EnabledModuleDto = z.infer<typeof enabledModuleDto>

/** `business.context` (business): everything the client needs to adapt to the active business. */
export const businessContextDto = z.object({
  /** `roles.template_key` of the member's role; null for a custom role. */
  roleTemplateKey: z.string().nullable(),
  permissions: effectivePermissionsDto,
  locationScope: locationScopeDto,
  visibleCategories: z.array(z.enum(SENSITIVITY_CATEGORIES)),
  modules: z.array(enabledModuleDto),
  /** The business's wording (businesses.terminology_profile): overlays of @bizcost/i18n. */
  terminologyProfile: z.enum(TERMINOLOGY_PROFILES),
  /** Every capability of the registry (stored and derived) → on/off. */
  capabilities: z.record(z.string(), z.boolean()),
  permissionsVersion: z.int().nonnegative(),
})
export type BusinessContextDto = z.infer<typeof businessContextDto>
