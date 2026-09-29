import {
  catalogIdInput,
  catalogListInput,
  createProductInput,
  productCostsDto,
  productCostsInput,
  productDto,
  productListDto,
  updateProductInput,
} from '@bizcost/contracts'
import {
  archiveProduct,
  createProduct,
  getProduct,
  listProducts,
  unarchiveProduct,
  updateProduct,
} from '../services/products'
import { productCosts } from '../services/recipes'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Products & Services (services/products.ts): module `products` (released and on for the business,
 * else MODULE_DISABLED; planned until M2 Step 7, so only the dev-only preview reaches it before then,
 * D-125), then products.items.view to read and products.items.manage to write. An item bought ready
 * to sell also writes its material (services/products.ts checks the Materials module and
 * materials.items.manage for it). `product.costs` needs the Materials module too (costs come from
 * materials) and products.recipes.view: how many lines a recipe has, which of its materials were
 * never bought and whether an item bought ready to sell was bought are recipe and purchase facts
 * (D-150), not part of the list every member sees; and materials.items.view, as recipes (D-155).
 */
const productsModule = businessProcedure.use(requireModule('products'))
const viewProducts = productsModule.use(requirePermission('products.items.view'))
const manageProducts = productsModule.use(requirePermission('products.items.manage'))
const viewProductCosts = productsModule
  .use(requireModule('materials'))
  .use(requirePermission('materials.items.view'))
  .use(requirePermission('products.recipes.view'))

export const productRouter = router({
  /** `product.list`: a page by name, with search and a status filter (active by default). */
  list: viewProducts
    .input(catalogListInput)
    .output(productListDto)
    .query(({ ctx, input }) => listProducts(ctx, input)),
  /** `product.get`: one product or service. */
  get: viewProducts
    .input(catalogIdInput)
    .output(productDto)
    .query(({ ctx, input }) => getProduct(ctx, input)),
  /**
   * `product.costs`: what the materials of one unit of each product cost today (its recipe, or its
   * material's average when bought ready to sell), unrounded, and whether it is complete; and the
   * owner's minutes for one unit (a business without a team, D-119). `cost` (withMeta).
   */
  costs: viewProductCosts
    .input(productCostsInput)
    .output(productCostsDto)
    .query(({ ctx, input }) => productCosts(ctx, input)),
  /** `product.create`: idempotent on the client's id; `resale` makes it bought ready to sell. */
  create: manageProducts
    .input(createProductInput)
    .output(productDto)
    .mutation(({ ctx, input }) => createProduct(ctx, input)),
  /**
   * `product.update`: the whole record, `version` as read. `ownerMinutes` (either procedure) is
   * written only when given: costs visible (FORBIDDEN) and no team (CAPABILITY_DISABLED).
   */
  update: manageProducts
    .input(updateProductInput)
    .output(productDto)
    .mutation(({ ctx, input }) => updateProduct(ctx, input)),
  /** `product.archive`: never a delete. */
  archive: manageProducts
    .input(catalogIdInput)
    .output(productDto)
    .mutation(({ ctx, input }) => archiveProduct(ctx, input)),
  /** `product.unarchive`. */
  unarchive: manageProducts
    .input(catalogIdInput)
    .output(productDto)
    .mutation(({ ctx, input }) => unarchiveProduct(ctx, input)),
})
