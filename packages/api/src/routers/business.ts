import { businessContextDto, type BusinessContextDto } from '@bizcost/contracts'
import { can, SENSITIVITY_CATEGORIES } from '@bizcost/domain'
import { buildModuleNav } from '@bizcost/modules'
import type { BusinessAccess } from '../access'
import { businessProcedure, router } from '../trpc'

export function toBusinessContext(access: BusinessAccess): BusinessContextDto {
  const { effective, locationScope } = access
  return {
    roleTemplateKey: access.roleTemplateKey,
    permissions: { all: effective.all, keys: [...effective.keys].sort() },
    locationScope: locationScope.all
      ? { all: true }
      : { all: false, ids: [...locationScope.ids].sort() },
    visibleCategories: SENSITIVITY_CATEGORIES.filter((c) => access.visibleCategories.has(c)),
    modules: [...buildModuleNav(access.enabledModules, (key) => can(effective, key))],
    capabilities: { ...access.capabilities },
    permissionsVersion: access.permissionsVersion,
  }
}

export const businessRouter = router({
  /**
   * `business.context`: everything the client needs to adapt to the active business — role, effective
   * permissions, location scope, visible sensitivity categories, released and enabled modules with the
   * nav entries this member may use, capabilities (vat_registered derived from the business) and the
   * permissions version.
   */
  context: businessProcedure
    .output(businessContextDto)
    .query(({ ctx }) => toBusinessContext(ctx.access)),
})
