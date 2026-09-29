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
import {
  buildModuleNav,
  isModuleActive,
  MODULES,
  visibleNav,
  type ModuleManifest,
} from '@bizcost/modules'
import type { BusinessAccess } from '../access'
import type { BusinessCtx } from '../business-context'
import {
  getProfile,
  logoUploadUrl,
  removeLogo,
  setDefaultLocale,
  setLogo,
  updateProfile,
} from '../services/business-profile'
import { customize, getCustomization } from '../services/customize'
import { payeeModules } from '../services/mine'
import { createFromSetup } from '../services/setup'
import { authedProcedure, businessProcedure, requirePermission, router } from '../trpc'

/**
 * `modules` is the server's registry (ctx.modules: with the dev-only preview, D-125); `payeeIn` the
 * modules in which the business owes (or paid back) the member for something they paid themselves
 * (their "Owed to me" entry, D-181).
 */
export function toBusinessContext(
  access: BusinessAccess,
  modules: readonly ModuleManifest[] = MODULES,
  payeeIn: ReadonlySet<string> = new Set(),
): BusinessContextDto {
  const { effective, locationScope } = access
  return {
    roleTemplateKey: access.roleTemplateKey,
    permissions: { all: effective.all, keys: [...effective.keys].sort() },
    locationScope: locationScope.all
      ? { all: true }
      : { all: false, ids: [...locationScope.ids].sort() },
    visibleCategories: SENSITIVITY_CATEGORIES.filter((c) => access.visibleCategories.has(c)),
    modules: [
      ...buildModuleNav(access.enabledModules, (key) => can(effective, key), modules, payeeIn),
    ],
    terminologyProfile: access.terminologyProfile,
    currency: access.currency,
    capabilities: { ...access.capabilities },
    permissionsVersion: access.permissionsVersion,
  }
}

/**
 * The active modules (Purchases, Expenses) with an entry for payees that the member does not already
 * reach by their keys through any module (Amounts owed is one page, D-166): only for those does
 * business.context look for what the member paid themselves (D-181).
 */
function payeeCandidates(ctx: BusinessCtx): Set<'purchases' | 'expenses'> {
  const byKeys = (key: string) => can(ctx.access.effective, key)
  const active = ctx.modules.filter((m) => isModuleActive(m, ctx.access.enabledModules))
  const reached = new Set(active.flatMap((m) => visibleNav(m, byKeys).map((e) => e.id)))
  const candidates = new Set<'purchases' | 'expenses'>()
  for (const manifest of active) {
    if (manifest.id !== 'purchases' && manifest.id !== 'expenses') continue
    if (manifest.nav.some((e) => e.payees === true && !reached.has(e.id))) {
      candidates.add(manifest.id)
    }
  }
  return candidates
}

const viewBusiness = businessProcedure.use(requirePermission('settings.business.view'))
const editBusiness = businessProcedure.use(requirePermission('settings.business.edit'))
const manageModules = businessProcedure.use(requirePermission('settings.modules.manage'))

export const businessRouter = router({
  /**
   * `business.context`: everything the client needs to adapt to the active business — role, effective
   * permissions, location scope, visible sensitivity categories, released and enabled modules with the
   * nav entries this member may use, capabilities (vat_registered derived from the business), the
   * wording, the currency and the permissions version.
   */
  context: businessProcedure
    .output(businessContextDto)
    .query(async ({ ctx }) =>
      toBusinessContext(ctx.access, ctx.modules, await payeeModules(ctx, payeeCandidates(ctx))),
    ),
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
