import {
  catalogIdInput,
  costCategoryDto,
  costCategoryListDto,
  costCategoryListInput,
  createCostCategoryInput,
  updateCostCategoryInput,
} from '@bizcost/contracts'
import {
  archiveCostCategory,
  createCostCategory,
  listCostCategories,
  unarchiveCostCategory,
  updateCostCategory,
} from '../services/cost-categories'
import { businessProcedure, requireAnyAccess, router } from '../trpc'

/**
 * The categories expenses and running costs share (services/cost-categories.ts; D-116, D-167): a
 * member who may see expenses or running costs (with that module on) lists them; one who may enter
 * expenses or change running costs adds, renames, archives or brings one back. Nothing is sensitive.
 */
const viewCategories = businessProcedure.use(
  requireAnyAccess(
    ['expenses', 'expenses.documents.view'],
    ['running_costs', 'running_costs.items.view'],
  ),
)
const manageCategories = businessProcedure.use(
  requireAnyAccess(
    ['expenses', 'expenses.documents.manage'],
    ['running_costs', 'running_costs.items.manage'],
  ),
)

export const costCategoryRouter = router({
  /** `costCategory.list`: by name, with search, status and a cursor. */
  list: viewCategories
    .input(costCategoryListInput)
    .output(costCategoryListDto)
    .query(({ ctx, input }) => listCostCategories(ctx, input)),
  /** `costCategory.create`: idempotent on the client's id; NAME_TAKEN names the one that has it. */
  create: manageCategories
    .input(createCostCategoryInput)
    .output(costCategoryDto)
    .mutation(({ ctx, input }) => createCostCategory(ctx, input)),
  /** `costCategory.update`: a new name, `version` as read. */
  update: manageCategories
    .input(updateCostCategoryInput)
    .output(costCategoryDto)
    .mutation(({ ctx, input }) => updateCostCategory(ctx, input)),
  /** `costCategory.archive`: hidden from pickers; what has it keeps it. */
  archive: manageCategories
    .input(catalogIdInput)
    .output(costCategoryDto)
    .mutation(({ ctx, input }) => archiveCostCategory(ctx, input)),
  /** `costCategory.unarchive`: back in the pickers. */
  unarchive: manageCategories
    .input(catalogIdInput)
    .output(costCategoryDto)
    .mutation(({ ctx, input }) => unarchiveCostCategory(ctx, input)),
})
