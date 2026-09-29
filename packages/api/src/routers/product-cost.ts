import {
  productCostBreakdownDto,
  productCostGetInput,
  productCostListDto,
  productCostListInput,
  productCostSettingsDto,
  updateProductCostSettingsInput,
} from '@bizcost/contracts'
import {
  getProductCost,
  getProductCostSettings,
  listProductCosts,
  updateProductCostSettings,
} from '../services/product-costs'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Product costs (services/product-costs.ts; M2 Step 6): module `cost_engine` (planned until M2 Step 7;
 * the dev-only preview reaches it before then, D-125).
 *   - `list` and `get` also need the Products & Services module on, and cost_engine.product_costs.view
 *     with what it needs (PERMISSION_NEEDS), checked here too since a member's own overrides can
 *     take a needed key away (D-155): products.items.view, products.recipes.view (a breakdown shows
 *     what goes into each product, D-150) and materials.items.view (it names the materials).
 *   - `settings` and `updateSettings` need cost_engine.settings.manage (and .product_costs.view:
 *     what the settings change), and running_costs.items.view and purchases.documents.view: the
 *     estimate and the rate it gives reveal the monthly running costs, and the settings show the
 *     months of purchases (D-186; checked as keys, as for the Owner, whether or not those modules
 *     are on). Writing also needs costs, supplier prices and margins visible (the service).
 * Outputs are withMeta(): costs `cost`, monthly purchases `supplier_price`, margins `profit_margin`.
 */
const costEngine = businessProcedure.use(requireModule('cost_engine'))
const viewProductCosts = costEngine
  .use(requireModule('products'))
  .use(requirePermission('products.items.view'))
  .use(requirePermission('materials.items.view'))
  .use(requirePermission('products.recipes.view'))
  .use(requirePermission('cost_engine.product_costs.view'))
const manageSettings = costEngine
  .use(requirePermission('cost_engine.product_costs.view'))
  .use(requirePermission('cost_engine.settings.manage'))
  .use(requirePermission('running_costs.items.view'))
  .use(requirePermission('purchases.documents.view'))

export const productCostRouter = router({
  /** `productCost.list`: every product's cost for one unit sold and margin, a page sorted as asked. */
  list: viewProductCosts
    .input(productCostListInput)
    .output(productCostListDto)
    .query(({ ctx, input }) => listProductCosts(ctx, input)),
  /** `productCost.get`: one product's cost, line by line, and how each line was worked out. */
  get: viewProductCosts
    .input(productCostGetInput)
    .output(productCostBreakdownDto)
    .query(({ ctx, input }) => getProductCost(ctx, input)),
  /** `productCost.settings`: the owner's estimate of monthly purchases and hourly rate. */
  settings: manageSettings
    .output(productCostSettingsDto)
    .query(({ ctx }) => getProductCostSettings(ctx)),
  /** `productCost.updateSettings`: each field given is saved (null clears it). */
  updateSettings: manageSettings
    .input(updateProductCostSettingsInput)
    .output(productCostSettingsDto)
    .mutation(({ ctx, input }) => updateProductCostSettings(ctx, input)),
})
