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
 * `tab`: its claim to a place in the phone's tab bar when not every entry fits (1 first; null: only
 * when there is room, else under "More"). The tabs keep the nav's order (M2 Step 7).
 */
export const navEntryDto = quickActionDto.extend({
  group: z.enum(NAV_GROUPS),
  tab: z.int().positive().nullable(),
})
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
  /**
   * The business sells only services (D-200): every product or service in use is a service; with none
   * in use yet, it was set up as a services business. What it sells is then worded as services (a
   * phone's tab, "Add a service").
   */
  sellsOnlyServices: z.boolean(),
  /** businesses.currency (ISO 4217, e.g. AED): the business's amounts are shown in it. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Every capability of the registry (stored and derived) → on/off. */
  capabilities: z.record(z.string(), z.boolean()),
  permissionsVersion: z.int().nonnegative(),
})
export type BusinessContextDto = z.infer<typeof businessContextDto>
