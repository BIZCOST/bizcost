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
 * Product costs (services/product-costs.ts; M2 Step 6): module `cost_engine` (released in M2 Step 7).
 *   - `list` and `get` also need the Products & Services module on, and cost_engine.product_costs.view
 *     with what it needs (PERMISSION_NEEDS), checked here too since a member's own overrides can
 *     take a needed key away (D-155): products.items.view, products.recipes.view (a breakdown shows
 *     what goes into each product, D-150) and materials.items.view (it names the materials).
 *   - `settings` and `updateSettings` need cost_engine.settings.manage (and .product_costs.view:
 *     what the settings change). They hold the owner's hourly rate only (D-119; running costs need no
 *     setting, D-202). Writing also needs costs visible and a business without a team (the service).
 * Outputs are withMeta(): costs `cost`, a material's last purchase price `supplier_price`, margins
 * `profit_margin`. The business's costs of a month are withheld by the service from a member who may
 * not see running costs and expenses (D-202).
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
  /** `productCost.settings`: the owner's hourly rate, and whether the business has a team. */
  settings: manageSettings
    .output(productCostSettingsDto)
    .query(({ ctx }) => getProductCostSettings(ctx)),
  /** `productCost.updateSettings`: the owner's hourly rate (null clears it). */
  updateSettings: manageSettings
    .input(updateProductCostSettingsInput)
    .output(productCostSettingsDto)
    .mutation(({ ctx, input }) => updateProductCostSettings(ctx, input)),
})
