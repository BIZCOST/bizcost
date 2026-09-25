import {
  businessContextDto,
  businessProfileDto,
  createFromSetupDto,
  createFromSetupInput,
  customizationDto,
  customizeDto,
  customizeInput,
  logoUploadUrlDto,
  logoUploadUrlInput,
  setDefaultLocaleInput,
  setLogoInput,
  updateBusinessProfileDto,
  updateBusinessProfileInput,
  type BusinessContextDto,
} from '@bizcost/contracts'
import { can, SENSITIVITY_CATEGORIES } from '@bizcost/domain'
import { buildModuleNav } from '@bizcost/modules'
import type { BusinessAccess } from '../access'
import {
  getProfile,
  logoUploadUrl,
  removeLogo,
  setDefaultLocale,
  setLogo,
  updateProfile,
} from '../services/business-profile'
import { customize, getCustomization } from '../services/customize'
import { createFromSetup } from '../services/setup'
import { authedProcedure, businessProcedure, requirePermission, router } from '../trpc'

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
    terminologyProfile: access.terminologyProfile,
    capabilities: { ...access.capabilities },
    permissionsVersion: access.permissionsVersion,
  }
}

const viewBusiness = businessProcedure.use(requirePermission('settings.business.view'))
const editBusiness = businessProcedure.use(requirePermission('settings.business.edit'))
const manageModules = businessProcedure.use(requirePermission('settings.modules.manage'))

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
  /**
   * `business.createFromSetup` (authed, outside any business): Smart Setup's confirm step. The server
   * recomputes recommend() from the answers and applies the review adjustments within their rules,
   * then creates the business, its setup, default location and roles in one transaction
   * (services/setup.ts). Idempotent on businessId; at most 10 businesses per user a day.
   */
  createFromSetup: authedProcedure
    .input(createFromSetupInput)
    .output(createFromSetupDto)
    .mutation(({ ctx, input }) => createFromSetup(ctx, ctx.auth, input)),

  // Settings → Business profile and language (services/business-profile.ts).

  /** `business.profile` (settings.business.view): names, logo URL (10 min), VAT/TRN, language. */
  profile: viewBusiness.output(businessProfileDto).query(({ ctx }) => getProfile(ctx)),
  /** `business.updateProfile` (settings.business.edit): names, VAT and TRN; `version` as read. */
  updateProfile: editBusiness
    .input(updateBusinessProfileInput)
    .output(updateBusinessProfileDto)
    .mutation(({ ctx, input }) => updateProfile(ctx, input)),
  /** `business.setDefaultLocale` (settings.business.edit): the business's language. */
  setDefaultLocale: editBusiness
    .input(setDefaultLocaleInput)
    .output(businessProfileDto)
    .mutation(({ ctx, input }) => setDefaultLocale(ctx, input)),
  /** `business.logoUploadUrl` (settings.business.edit): a signed URL to upload a new logo. */
  logoUploadUrl: editBusiness
    .input(logoUploadUrlInput)
    .output(logoUploadUrlDto)
    .mutation(({ ctx, input }) => logoUploadUrl(ctx, input)),
  /** `business.setLogo` (settings.business.edit): checks the uploaded object and saves it. */
  setLogo: editBusiness
    .input(setLogoInput)
    .output(businessProfileDto)
    .mutation(({ ctx, input }) => setLogo(ctx, input)),
  /** `business.removeLogo` (settings.business.edit). */
  removeLogo: editBusiness.output(businessProfileDto).mutation(({ ctx }) => removeLogo(ctx)),

  // Settings → Customize BizCost (services/customize.ts).

  /** `business.customization` (settings.modules.manage): modules, capabilities, what is in use. */
  customization: manageModules.output(customizationDto).query(({ ctx }) => getCustomization(ctx)),
  /** `business.customize` (settings.modules.manage): one switch, with the review's rules. */
  customize: manageModules
    .input(customizeInput)
    .output(customizeDto)
    .mutation(({ ctx, input }) => customize(ctx, input)),
})
