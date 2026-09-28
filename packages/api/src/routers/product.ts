import {
  catalogIdInput,
  catalogListInput,
  createProductInput,
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
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Products & Services (services/products.ts): module `products` (released and on for the business,
 * else MODULE_DISABLED; planned until M2 Step 7, so only the dev-only preview reaches it before then,
 * D-125), then products.items.view to read and products.items.manage to write.
 */
const productsModule = businessProcedure.use(requireModule('products'))
const viewProducts = productsModule.use(requirePermission('products.items.view'))
const manageProducts = productsModule.use(requirePermission('products.items.manage'))

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
  /** `product.create`: idempotent on the client's id. */
  create: manageProducts
    .input(createProductInput)
    .output(productDto)
    .mutation(({ ctx, input }) => createProduct(ctx, input)),
  /** `product.update`: the whole record, `version` as read. */
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
