import {
  catalogIdInput,
  catalogListInput,
  createSupplierInput,
  supplierDto,
  supplierListDto,
  updateSupplierInput,
} from '@bizcost/contracts'
import {
  archiveSupplier,
  createSupplier,
  getSupplier,
  listSuppliers,
  unarchiveSupplier,
  updateSupplier,
} from '../services/suppliers'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Suppliers (services/suppliers.ts): module `suppliers` (planned until M2 Step 7, so only the dev-only
 * preview reaches it before then, D-125), then suppliers.items.view to read and
 * suppliers.items.manage to write.
 */
const suppliersModule = businessProcedure.use(requireModule('suppliers'))
const viewSuppliers = suppliersModule.use(requirePermission('suppliers.items.view'))
const manageSuppliers = suppliersModule.use(requirePermission('suppliers.items.manage'))

export const supplierRouter = router({
  /** `supplier.list`: a page by name, with search and a status filter (active by default). */
  list: viewSuppliers
    .input(catalogListInput)
    .output(supplierListDto)
    .query(({ ctx, input }) => listSuppliers(ctx, input)),
  /** `supplier.get`. */
  get: viewSuppliers
    .input(catalogIdInput)
    .output(supplierDto)
    .query(({ ctx, input }) => getSupplier(ctx, input)),
  /** `supplier.create`: idempotent on the client's id. */
  create: manageSuppliers
    .input(createSupplierInput)
    .output(supplierDto)
    .mutation(({ ctx, input }) => createSupplier(ctx, input)),
  /** `supplier.update`: the whole record, `version` as read. */
  update: manageSuppliers
    .input(updateSupplierInput)
    .output(supplierDto)
    .mutation(({ ctx, input }) => updateSupplier(ctx, input)),
  /** `supplier.archive`: never a delete. */
  archive: manageSuppliers
    .input(catalogIdInput)
    .output(supplierDto)
    .mutation(({ ctx, input }) => archiveSupplier(ctx, input)),
  /** `supplier.unarchive`. */
  unarchive: manageSuppliers
    .input(catalogIdInput)
    .output(supplierDto)
    .mutation(({ ctx, input }) => unarchiveSupplier(ctx, input)),
})
